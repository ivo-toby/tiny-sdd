import type { Stock } from "./inventory.ts";
import { createReservationService } from "./service.ts";

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

    return jsonResponse(404, { error: "NOT_FOUND" });
  };
}
