
const { ApiError } = require("./errors");

const QR_API =
  "https://api.qrserver.com/v1/create-qr-code/";

const MAX_IMAGE_SIZE = 1024 * 1024;

// Generate a QR code using the external goQR.me API.
async function generateQr(reservationId) {
  const url = new URL(QR_API);

  url.searchParams.set("data", reservationId);
  url.searchParams.set("size", "250x250");
  url.searchParams.set("format", "png");
  url.searchParams.set("qzone", "4");

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "image/png",
      },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });

    // Ensure the external API returns a PNG image.
    if (
      !response.ok ||
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("image/png") ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new Error("Invalid QR API response.");
    }

    const chunks = [];
    let totalSize = 0;

    for await (const chunk of response.body) {
      totalSize += chunk.length;

      if (totalSize > MAX_IMAGE_SIZE) {
        throw new Error("QR image is too large.");
      }

      chunks.push(Buffer.from(chunk));
    }

    const image = Buffer.concat(chunks);

    // Verify the PNG file signature.
    const pngSignature = Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);

    if (
      !image.subarray(0, 8).equals(pngSignature)
    ) {
      throw new Error("Invalid PNG image.");
    }

    return image;

  } catch {
    throw new ApiError(
      503,
      "QR_UNAVAILABLE",
      "QR code generation is temporarily unavailable."
    );
  }
}

module.exports = {
  generateQr,
};
