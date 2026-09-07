import { createReservationService } from "./service.ts";
import { validateReservation } from "./validation.ts";
import type { Stock } from "./inventory.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createApp(
  initialStock: Stock,
): (request: Request) => Promise<Response> {
  const service = createReservationService(initialStock);

  return async function handle(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (request.method === "GET" && pathname === "/health") {
      return jsonResponse(200, { ok: true });
    }
    if (request.method === "GET" && pathname === "/stock") {
      return jsonResponse(200, { stock: service.getStock() });
    }
    if (request.method !== "POST" || pathname !== "/reservations") {
      return jsonResponse(404, { error: "NOT_FOUND" });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: "INVALID_JSON" });
    }

    const validation = validateReservation(body);
    if (!validation.ok) {
      return jsonResponse(400, { error: "INVALID_REQUEST" });
    }

    const result = service.reserve(validation.command);
    return jsonResponse(result.status, result.body);
  };
}
