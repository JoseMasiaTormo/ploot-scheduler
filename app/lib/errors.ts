// Error de API con código tipado: el cliente siempre recibe { error, message }
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json({ error: err.code, message: err.message, ...err.details }, { status: err.status });
  }
  const pgCode = (err as { code?: string })?.code;
  if (pgCode === "23514") {
    return Response.json({ error: "invalid_state", message: "Combinación de campos no válida" }, { status: 400 });
  }
  console.error(JSON.stringify({ event: "api_error", error: String(err) }));
  return Response.json({ error: "internal_error", message: "Error interno" }, { status: 500 });
}

// Envuelve un handler: cualquier error se convierte en una respuesta JSON coherente
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}
