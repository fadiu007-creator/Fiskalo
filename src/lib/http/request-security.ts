export type SameOriginJsonPostFailure = "origin" | "content-type" | null;

/**
 * Enforce the browser request boundary used by cookie-authenticated POST routes.
 * A JSON media type is required because it is not a CORS-safelisted content type,
 * and the Origin must match the request URL's origin exactly.
 */
export function validateSameOriginJsonPost(request: Request): SameOriginJsonPostFailure {
  const origin = request.headers.get("origin");
  if (!origin) return "origin";

  try {
    if (new URL(origin).origin !== new URL(request.url).origin) return "origin";
  } catch {
    return "origin";
  }

  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") return "content-type";

  return null;
}
