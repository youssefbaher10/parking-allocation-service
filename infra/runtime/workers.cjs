
// Local parking runtime: child processes + path-aware round robin.
// The supervisor owns only the processes it starts.

const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

const {
  createCloudWatchForwarder,
} = require("./cloudwatch.cjs");

const base = path.resolve(".local/runtime");
const state = path.join(base, "control.json");

const [mode, arg] = process.argv.slice(2);

const ports = [3001, 3011, 3021];
const host = "127.0.0.1";
const controlPort = 8099;
const proxyPort = 8080;

// Start a server on a specific port.
const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);

    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

// Check whether a port is available.
const checkPort = async (port) => {
  const server = net.createServer();

  try {
    await listen(server, port);
  } catch {
    throw new Error(
      `Port ${port} is busy. Stop the existing app yourself; no unrelated process was killed.`
    );
  }

  await new Promise((resolve) => server.close(resolve));
};

// Check ports before starting workers.
async function preflight(n) {
  if (![1, 2, 3].includes(n)) {
    throw new Error("Expected 1 to 3 workers");
  }

  for (const port of [
    controlPort,
    proxyPort,
    ...ports.slice(0, n),
  ]) {
    await checkPort(port);
  }
}

// Send an authenticated command to the supervisor.
async function control(action) {
  const cfg = JSON.parse(
    fs.readFileSync(state, "utf8")
  );

  if (cfg.port !== controlPort) {
    throw new Error("Invalid control file");
  }

  const response = await fetch(
    `http://${host}:${controlPort}/`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(5000),
    }
  );

  console.log(await response.text());

  if (!response.ok) {
    process.exitCode = 1;
  }
}

// Start the local deployment.
async function start(n) {
  await preflight(n);

  fs.mkdirSync(base, {
    recursive: true,
    mode: 0o700,
  });

  fs.mkdirSync(path.join(base, "logs"), {
    recursive: true,
  });

  require("dotenv").config({ quiet: true });

  // Initialize CloudWatch log forwarding.
  const cloudwatch = createCloudWatchForwarder();

  const token = randomBytes(32).toString("hex");

  const workers = [];

  const pools = {
    allocation: workers,
    inventory: [],
    incidents: [],
  };

  const cursor = {
    allocation: 0,
    inventory: 0,
    incidents: 0,
  };

  // Optional teammate services.
  // They must already be running locally.
  for (const [name, env] of [
    ["inventory", "PARKING_INVENTORY_PORTS"],
    ["incidents", "PARKING_INCIDENT_PORTS"],
  ]) {
    if (process.env[env]) {
      for (const val of process.env[env].split(",")) {
        const port = Number(val);

        if (
          !Number.isInteger(port) ||
          port < 1024 ||
          port > 65535 ||
          [controlPort, proxyPort, ...ports].includes(port) ||
          Object.values(pools)
            .flat()
            .some((worker) => worker.port === port)
        ) {
          throw new Error("Invalid teammate port");
        }

        pools[name].push({
          port,
          id: `${name}-${port}`,
          healthy: false,
        });
      }
    }
  }

  let stopping = false;
  let timer;
  let proxy;
  let ctl;

  // Stop only processes owned by this supervisor.
  const shutdown = () => {
    if (stopping) return;

    stopping = true;

    clearInterval(timer);

    for (const worker of workers) {
      if (worker.child.exitCode === null) {
        worker.child.kill();
      }
    }

    proxy?.close();
    ctl?.close();

    try {
      fs.unlinkSync(state);
    } catch {
      // Control file may already have been removed.
    }
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  process.once("exit", () => {
    for (const worker of workers) {
      if (worker.child.exitCode === null) {
        worker.child.kill();
      }
    }
  });

  // Check worker health.
  const probe = async (worker) => {
    if (
      worker.child &&
      (worker.child.exitCode !== null ||
        worker.child.killed)
    ) {
      worker.healthy = false;
      return;
    }

    try {
      const response = await fetch(
        `http://${host}:${worker.port}/health`,
        {
          signal: AbortSignal.timeout(900),
        }
      );

      worker.healthy = response.ok;
    } catch {
      worker.healthy = false;
    }
  };

  try {
    // Start Allocation Service workers.
    for (let i = 0; i < n; i++) {
      const id = `allocation-${i + 1}`;
      const port = ports[i];

      const child = spawn(
        process.execPath,
        ["index.js"],
        {
          cwd: process.cwd(),

          env: {
            ...process.env,
            PORT: String(port),
            INSTANCE_ID: id,
          },

          // Capture output for local and CloudWatch logs.
          stdio: ["ignore", "pipe", "pipe"],

          windowsHide: true,
        }
      );

      const worker = {
        id,
        port,
        child,
        healthy: false,
      };

      workers.push(worker);

      child.on("error", (error) => {
        worker.healthy = false;
        console.error(id, error.message);
      });

      child.on("exit", () => {
        worker.healthy = false;
        console.log(`${id} stopped`);
      });

      // Forward runtime logs to CloudWatch
      // while preserving local log files.
      cloudwatch.attach(
        child,
        id,
        path.join(base, "logs", id + ".log")
      );
    }

    // Wait for workers to become healthy.
    for (let attempts = 0; attempts < 30; attempts++) {
      await Promise.all(workers.map(probe));

      if (workers.every((worker) => worker.healthy)) {
        break;
      }

      await delay(500);
    }

    if (!workers.every((worker) => worker.healthy)) {
      throw new Error(
        "Worker did not become healthy. Inspect .local/runtime/logs/ (do not share secrets)."
      );
    }

    // Check all service pools.
    await Promise.all(
      Object.values(pools).flat().map(probe)
    );

    // Repeat health checks every three seconds.
    timer = setInterval(() => {
      Promise.all(
        Object.values(pools).flat().map(probe)
      ).catch(() => {});
    }, 3000);

    // Local load balancing proxy.
    proxy = http.createServer((req, res) => {
      const url = new URL(
        req.url,
        "http://localhost"
      );

      const name =
        url.pathname === "/health"
          ? "allocation"
          : /^\/api\/(allocation|inventory|incidents)(?:\/|$)/
              .exec(url.pathname)?.[1];

      // Reject unknown routes.
      if (!name) {
        res.writeHead(404, {
          "content-type": "application/json",
        });

        return res.end(
          '{"error":"Unknown route"}'
        );
      }

      // Only route requests to healthy workers.
      const pool = pools[name].filter(
        (worker) => worker.healthy
      );

      if (!pool.length) {
        res.writeHead(503, {
          "content-type": "application/json",
        });

        return res.end(
          '{"error":"No healthy worker"}'
        );
      }

      // Round-robin worker selection.
      const worker =
        pool[cursor[name]++ % pool.length];

      const headers = {
        ...req.headers,
        host: `${host}:${worker.port}`,
      };

      // Remove connection-specific and untrusted headers.
      for (const key of [
        "connection",
        "proxy-connection",
        "keep-alive",
        "upgrade",
        "proxy-authorization",
        "te",
        "trailer",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "forwarded",
      ]) {
        delete headers[key];
      }

      // Forward the request to the selected worker.
      const upstream = http.request(
        {
          hostname: host,
          port: worker.port,
          path: req.url,
          method: req.method,
          headers,
          timeout: 15000,
        },
        (response) => {
          const responseHeaders = {
            ...response.headers,
            "x-parking-instance": worker.id,
          };

          for (const key of [
            "connection",
            "keep-alive",
            "upgrade",
            "trailer",
          ]) {
            delete responseHeaders[key];
          }

          res.writeHead(
            response.statusCode,
            responseHeaders
          );

          response.pipe(res);
        }
      );

      upstream.on("timeout", () => {
        upstream.destroy(
          new Error("upstream timeout")
        );
      });

      upstream.on("error", () => {
        worker.healthy = false;

        if (!res.headersSent) {
          res.writeHead(502, {
            "content-type": "application/json",
          });

          res.end(
            '{"error":"Upstream unavailable"}'
          );
        } else {
          res.destroy();
        }
      });

      req.on("aborted", () => {
        upstream.destroy();
      });

      res.on("close", () => {
        if (!res.writableEnded) {
          upstream.destroy();
        }
      });

      req.pipe(upstream);
    });

    // Secure local supervisor control server.
    ctl = http.createServer(async (req, res) => {
      if (
        req.method !== "POST" ||
        req.headers.authorization !== `Bearer ${token}`
      ) {
        res.writeHead(403);
        return res.end("Forbidden");
      }

      try {
        let raw = "";

        for await (const chunk of req) {
          raw += chunk;

          if (raw.length > 4096) {
            throw new Error("Too large");
          }
        }

        const { action } = JSON.parse(raw);

        // Display worker status.
        if (action === "status") {
          const info = Object.fromEntries(
            Object.entries(pools).map(([key, value]) => [
              key,
              value.map(({ id, port, healthy }) => ({
                id,
                port,
                healthy,
              })),
            ])
          );

          res.end(
            JSON.stringify(info, null, 2)
          );

        // Stop the entire local deployment.
        } else if (action === "stop") {
          res.end(
            "Stopping owned workers and proxy"
          );

          setImmediate(shutdown);

        // Simulate worker failure.
        } else if (/^kill:[1-3]$/.test(action)) {
          const worker =
            workers[Number(action.slice(-1)) - 1];

          if (
            !worker ||
            worker.child.exitCode !== null ||
            worker.child.killed
          ) {
            throw new Error("Worker not running");
          }

          worker.healthy = false;
          worker.child.kill();

          res.end(
            `Stopped ${worker.id} for failover drill`
          );

        } else {
          throw new Error("Unknown action");
        }

      } catch (error) {
        res.writeHead(400);
        res.end(error.message);
      }
    });

    // Start the control server and proxy.
    await listen(ctl, controlPort);
    await listen(proxy, proxyPort);

    // Store private local control configuration.
    fs.writeFileSync(
      state,
      JSON.stringify({
        port: controlPort,
        token,
      }),
      {
        mode: 0o600,
      }
    );

    console.log(
      `Parking local proxy: http://localhost:${proxyPort} — ${n} Allocation worker(s)`
    );

    for (const worker of workers) {
      console.log(
        `${worker.id}: ${worker.port} healthy`
      );
    }

    console.log(
      "CloudWatch log forwarding enabled."
    );

    console.log(
      "Keep this terminal open. Use scale-test.sh status / kill 2 / stop in a second terminal."
    );

  } catch (error) {
    shutdown();
    throw error;
  }
}

// Process command-line arguments.
(async () => {
  if (mode === "preflight") {
    await preflight(Number(arg));

  } else if (mode === "start") {
    await start(Number(arg));

  } else if (mode === "control") {
    await control(arg);

  } else {
    throw new Error("Unknown worker command");
  }

})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
