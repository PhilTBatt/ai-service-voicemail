// Talking to the dashboard API. Every request carries the person's Clerk session token as a
// bearer token; the API checks it and decides what they may see. In development Vite passes
// /api through to the API on localhost (vite.config.ts), so the browser sees one site.
import { useAuth } from "@clerk/react";
import { useCallback, useEffect, useState } from "react";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

interface RequestOptions {
  method?: "GET" | "PUT" | "POST";
  body?: unknown;
}

/** A function that calls the API as the signed-in person and parses the JSON reply. */
export type Api = <T>(path: string, options?: RequestOptions) => Promise<T>;

export function useApi(): { api: Api; fetchBlob: (path: string) => Promise<Blob> } {
  const { getToken } = useAuth();

  const send = useCallback(
    async (path: string, options: RequestOptions = {}): Promise<Response> => {
      // getToken() returns a fresh short-lived token, renewing it when needed.
      const token = await getToken();
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (options.body !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(`/api${path}`, {
        method: options.method ?? "GET",
        headers,
        ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: unknown };
        throw new ApiError(
          response.status,
          typeof body.error === "string" ? body.error : response.statusText,
        );
      }
      return response;
    },
    [getToken],
  );

  const api = useCallback<Api>(
    async <T>(path: string, options?: RequestOptions) =>
      (await (await send(path, options)).json()) as T,
    [send],
  );
  const fetchBlob = useCallback(async (path: string) => (await send(path)).blob(), [send]);
  return { api, fetchBlob };
}

export type Loaded<T> =
  { status: "loading" } | { status: "ready"; data: T } | { status: "error"; error: Error };

/**
 * Runs `load` when the page opens and again whenever `key` changes, ignoring answers that
 * arrive after the page has moved on. `reload()` runs it again on demand.
 */
export function useLoad<T>(
  load: () => Promise<T>,
  key: string,
): Loaded<T> & { reload: () => void } {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    void load().then(
      (data) => {
        if (current) setState({ status: "ready", data });
      },
      (error: unknown) => {
        if (current) setState({ status: "error", error: asError(error) });
      },
    );
    return () => {
      current = false;
    };
    // `load` is a new function on every render; `key` says when it means something new.
  }, [key, attempt]);

  return { ...state, reload: () => setAttempt((n) => n + 1) };
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
