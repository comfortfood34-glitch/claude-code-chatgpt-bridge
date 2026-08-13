import express, { type Request, type Response } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { fireClaudeRoutine } from "./claude.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "80kb" }));

function authorized(req: Request): boolean {
  const expected = process.env.BRIDGE_ACCESS_TOKEN;
  if (!expected) return false;
  const received = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireAuth(req: Request, res: Response): boolean {
  if (authorized(req)) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "Claude Code Bridge", version: "0.1.0" });
  server.registerTool(
    "send_to_claude_code",
    {
      title: "Enviar tarefa ao Claude Code",
      description:
        "Inicia uma sessão real do Claude Code Web no projeto configurado. Use para auditoria, investigação ou implementação solicitada pelo usuário. A ferramenta retorna o link da sessão; nunca afirme que o trabalho terminou apenas porque a sessão foi criada.",
      inputSchema: {
        task: z.string().min(1).max(65_536).describe("Instrução completa para o Claude Code, incluindo contexto, restrições e resultado esperado."),
        mode: z.enum(["read_only", "implementation"]).default("read_only").describe("read_only proíbe alterações; implementation permite alterações conforme as regras salvas na rotina.")
      }
    },
    async ({ task, mode }) => {
      const guardrail = mode === "read_only"
        ? "MODO OBRIGATÓRIO: somente leitura. Não edite arquivos, não crie commit, não faça deploy e não altere dados.\n\n"
        : "MODO IMPLEMENTAÇÃO: não faça deploy nem altere produção. Edite somente o repositório configurado e apresente diff/testes para revisão humana.\n\n";
      const result = await fireClaudeRoutine(`${guardrail}${task}`);
      return {
        content: [{
          type: "text",
          text: `Sessão do Claude Code iniciada.\nID: ${result.claude_code_session_id}\nAbrir e acompanhar: ${result.claude_code_session_url}\n\nA API de Rotinas apenas inicia a sessão; abra o link para acompanhar o resultado e continuar a conversa.`
        }]
      };
    }
  );
  return server;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "claude-code-chatgpt-bridge" });
});

app.post("/mcp", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error instanceof Error ? error.message : "internal_error" });
    }
  }
});

app.get("/mcp", (req, res) => {
  if (!requireAuth(req, res)) return;
  res.status(405).json({ error: "stateless_server_does_not_support_sse" });
});

app.delete("/mcp", (req, res) => {
  if (!requireAuth(req, res)) return;
  res.status(405).json({ error: "stateless_server_has_no_sessions" });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "server_started", port, instance: randomUUID() }));
});
