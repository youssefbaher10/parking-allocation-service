
const fs = require("node:fs");
const readline = require("node:readline");

const {
  CloudWatchLogsClient,
  PutLogEventsCommand,
} = require("@aws-sdk/client-cloudwatch-logs");

function createCloudWatchForwarder() {
  const client = new CloudWatchLogsClient({
    region: process.env.AWS_REGION || "us-east-1",
    endpoint: "http://localhost:4566",
    maxAttempts: 1,
  });

  const pending = [];
  let sending = false;

  function collect(instance, line) {
    let event;

    try {
      const data = JSON.parse(line);

      if (data.event === "api_access") {
        if (!Number.isInteger(data.status)) return;

        event = {
          event: "api_access",
          instance,
          method: data.method,
          route: data.route,
          status: data.status,
        };
      } else if (data.event === "error") {
        event = {
          event: "error",
          instance,
        };
      }
    } catch {
      const startup = line.match(
        /^Allocation service listening on port (\d+)$/
      );

      if (startup) {
        event = {
          event: "worker_started",
          instance,
          port: Number(startup[1]),
        };
      }
    }

    if (!event) return;

    // Keep the memory buffer bounded.
    if (pending.length >= 5000) {
      pending.shift();
    }

    pending.push({
      timestamp: Date.now(),
      message: JSON.stringify(event),
    });
  }

  async function flush() {
    if (sending || pending.length === 0) return;

    sending = true;

    const batch = pending
      .slice(0, 100)
      .sort((a, b) => a.timestamp - b.timestamp);

    try {
      await client.send(
        new PutLogEventsCommand({
          logGroupName: "/aws/ecs/parking-allocation",
          logStreamName: "local-workers",
          logEvents: batch,
        }),
        {
          abortSignal: AbortSignal.timeout(5000),
        }
      );

      pending.splice(0, batch.length);
    } catch {
      console.error(
        "CloudWatch delivery failed; local logs remain available."
      );
    } finally {
      sending = false;
    }
  }

  // Forward collected events every two seconds.
  setInterval(flush, 2000).unref();

  function attach(child, instance, logPath) {
    const localLog = fs.createWriteStream(logPath, {
      flags: "a",
    });

    localLog.on("error", () => {
      console.error("Local log write failed:", instance);
    });

    for (const stream of [child.stdout, child.stderr]) {
      // Preserve the existing local logs.
      stream.pipe(localLog, { end: false });

      const reader = readline.createInterface({
        input: stream,
        crlfDelay: Infinity,
      });

      reader.on("line", (line) => {
        collect(instance, line);
      });
    }

    child.once("close", () => {
      localLog.end();
    });
  }

  return { attach };
}

module.exports = { createCloudWatchForwarder };
