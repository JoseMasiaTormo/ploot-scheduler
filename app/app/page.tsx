"use client";

import { useCallback, useEffect, useState } from "react";

type Post = {
  id: string;
  content: string;
  status: string;
  scheduled_at: string | null;
  next_attempt_at: string | null;
  attempts: number;
  external_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
};

type Lag = {
  profile_id: string;
  display_name: string;
  blocked_until: string | null;
  token_status: string | null;
  overdue_posts: string;
  in_flight: string;
  last_error_code: string | null;
};

const STATUS_COLORS: Record<string, string> = {
  draft: "#8a8a85",
  scheduled: "#2f6fb0",
  publishing: "#b07a1f",
  published: "#2e7d4f",
  failed: "#b03a2e",
  cancelled: "#5f5f5b",
};

function fmt(date: string | null) {
  return date ? new Date(date).toLocaleString("es-ES", { timeZone: "Europe/Madrid" }) : "—";
}

function reason(post: Post) {
  if (post.status === "failed") return `${post.last_error_code}: ${post.last_error_message}`;
  if (post.status === "scheduled" && post.last_error_code === "rate_limited") {
    return `Esperando por 429 (Retry-After) hasta ${fmt(post.next_attempt_at)}`;
  }
  if (post.status === "scheduled" && post.last_error_code) {
    return `Reintento ${post.attempts} tras ${post.last_error_code}, próximo ${fmt(post.next_attempt_at)}`;
  }
  if (post.status === "published") return `external_id: ${post.external_id}`;
  return "";
}

export default function Home() {
  const [token, setToken] = useState("");
  const [posts, setPosts] = useState<Post[]>([]);
  const [lag, setLag] = useState<Lag[]>([]);
  const [error, setError] = useState("");
  const [content, setContent] = useState("");
  const [when, setWhen] = useState("");

  useEffect(() => {
    try {
      setToken(localStorage.getItem("ploot_token") ?? "");
    } catch {}
  }, []);

  const api = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const res = await fetch(path, {
        ...init,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${res.status} ${body.error ?? ""}: ${body.message ?? ""}`);
      return body;
    },
    [token],
  );

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const [list, ops] = await Promise.all([api("/api/v1/posts?limit=50"), api("/api/v1/ops/lag")]);
      setPosts(list.items);
      setLag(ops.profiles);
      setError("");
    } catch (err) {
      setError(String(err));
    }
  }, [api, token]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  function saveToken(value: string) {
    setToken(value.trim());
    try {
      localStorage.setItem("ploot_token", value.trim());
    } catch {}
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/api/v1/posts", {
        method: "POST",
        body: JSON.stringify(
          when
            ? { content, status: "scheduled", scheduled_local: when, timezone: "Europe/Madrid" }
            : { content, status: "draft" },
        ),
      });
      setContent("");
      setWhen("");
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function publishNow(id: string) {
    try {
      await api(`/api/v1/posts/${id}/publish`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function cancel(id: string) {
    try {
      await api(`/api/v1/posts/${id}`, { method: "DELETE" });
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 16, display: "grid", gap: 16 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Scheduler · demo</h1>

      <label style={{ display: "grid", gap: 4 }}>
        JWT del Embajador
        <input
          value={token}
          onChange={(e) => saveToken(e.target.value)}
          placeholder="Pega aquí el token de npm run tokens"
        />
      </label>

      {error && <p style={{ color: "#b03a2e", margin: 0 }}>{error}</p>}

      <form onSubmit={create} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end" }}>
        <label style={{ display: "grid", gap: 4, flex: "1 1 320px" }}>
          Contenido
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={2} required />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          Programar (hora de Madrid, vacío = borrador)
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
        <button type="submit" style={{ padding: "8px 16px" }}>
          Crear
        </button>
      </form>

      <section>
        <h2 style={{ fontSize: 18 }}>Posts (se actualiza cada 2 s)</h2>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Contenido</th>
                <th>Estado</th>
                <th>Programado</th>
                <th>Intentos</th>
                <th>Por qué</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {posts.map((post) => (
                <tr key={post.id}>
                  <td>{post.content}</td>
                  <td style={{ color: STATUS_COLORS[post.status], fontWeight: 600 }}>{post.status}</td>
                  <td>{fmt(post.scheduled_at)}</td>
                  <td>{post.attempts}</td>
                  <td>{reason(post)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {["draft", "scheduled", "failed"].includes(post.status) && (
                      <>
                        <button onClick={() => publishNow(post.id)}>Publicar ahora</button>{" "}
                        <button onClick={() => cancel(post.id)}>Cancelar</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: 18 }}>¿Por qué va atrasado cada Embajador?</h2>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Embajador</th>
                <th>Vencidos</th>
                <th>En vuelo</th>
                <th>Bloqueado por 429 hasta</th>
                <th>Token</th>
                <th>Último error</th>
              </tr>
            </thead>
            <tbody>
              {lag.map((row) => (
                <tr key={row.profile_id}>
                  <td>{row.display_name}</td>
                  <td>{row.overdue_posts}</td>
                  <td>{row.in_flight}</td>
                  <td>{fmt(row.blocked_until)}</td>
                  <td>{row.token_status ?? "—"}</td>
                  <td>{row.last_error_code ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
