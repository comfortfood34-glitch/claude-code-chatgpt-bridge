import express, { type Request, type Response } from "express";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { fireClaudeRoutine } from "./claude.js";

const app = express();
app.disable("x-powered-by"); app.set("trust proxy", 1);
app.use(express.json({ limit: "80kb" })); app.use(express.urlencoded({ extended: false }));
type Payload = Record<string, unknown> & { exp: number; kind: string };
const bridgeSecret = () => {
  const value = process.env.BRIDGE_ACCESS_TOKEN;
  if (!value || value.length < 32) throw new Error("BRIDGE_ACCESS_TOKEN must be at least 32 characters.");
  return value;
};
const baseUrl = (req: Request) => `${req.protocol}://${req.get("host")}`;
const sign = (payload: Payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", bridgeSecret()).update(body).digest("base64url")}`;
};
function verify(token: string, kind: string): Payload | undefined {
  const [body, signature] = token.split("."); if (!body || !signature) return;
  const expected = createHmac("sha256", bridgeSecret()).update(body).digest("base64url");
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()) as Payload; return p.kind === kind && p.exp > Date.now() / 1000 ? p : undefined; } catch { return; }
}
function safeRedirect(value: string) {
  try { const u = new URL(value); return u.protocol === "https:" && (u.hostname === "chatgpt.com" || u.hostname.endsWith(".openai.com")); } catch { return false; }
}
const esc = (value: string) => value.replace(/[&<>'"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[c]!);
function requireAuth(req: Request, res: Response) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (verify(token, "access")) return true;
  res.set("WWW-Authenticate", `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource/mcp"`);
  res.status(401).json({ error: "unauthorized" }); return false;
}

function mcpServer() {
  const server = new McpServer({ name: "Claude Code Bridge", version: "0.2.0" });
  server.registerTool("send_to_claude_code", {
    title: "Enviar tarefa ao Claude Code",
    description: "Inicia uma sessão real do Claude Code Web e devolve o link da sessão.",
    inputSchema: { task: z.string().min(1).max(65_536), mode: z.enum(["read_only", "implementation"]).default("read_only") }
  }, async ({ task, mode }) => {
    const rule = mode === "read_only"
      ? "MODO OBRIGATÓRIO: somente leitura. Não edite, não faça commit ou deploy e não altere dados.\n\n"
      : "MODO IMPLEMENTAÇÃO: não faça deploy nem altere produção. Apresente diff e testes para revisão.\n\n";
    const result = await fireClaudeRoutine(rule + task);
    return { content: [{ type: "text", text: `Sessão iniciada.\nID: ${result.claude_code_session_id}\nAbrir: ${result.claude_code_session_url}` }] };
  }); return server;
}

app.get("/health", (_req, res) => res.json({ status: "ok", service: "claude-code-chatgpt-bridge" }));
app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (req, res) => {
  const base = baseUrl(req); res.json({ resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"] });
});
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = baseUrl(req); res.json({ issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
});
app.post("/oauth/register", (req, res) => {
  const uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.filter((x: unknown) => typeof x === "string") : [];
  if (!uris.length || !uris.every(safeRedirect)) { res.status(400).json({ error: "invalid_redirect_uri" }); return; }
  res.status(201).json({ client_id: "chatgpt-claude-code-bridge", redirect_uris: uris, token_endpoint_auth_method: "none" });
});
app.get("/oauth/authorize", (req, res) => {
  const v = { client_id:String(req.query.client_id??""), redirect_uri:String(req.query.redirect_uri??""), state:String(req.query.state??""), code_challenge:String(req.query.code_challenge??""), code_challenge_method:String(req.query.code_challenge_method??""), response_type:String(req.query.response_type??"") };
  if (v.client_id !== "chatgpt-claude-code-bridge" || v.response_type !== "code" || v.code_challenge_method !== "S256" || !safeRedirect(v.redirect_uri)) { res.status(400).send("Invalid OAuth request"); return; }
  const hidden = Object.entries(v).map(([k,x]) => `<input type="hidden" name="${k}" value="${esc(x)}">`).join("");
  res.type("html").send(`<!doctype html><html lang="pt"><meta charset="utf-8"><title>Autorizar ponte</title><style>body{font:16px system-ui;max-width:520px;margin:70px auto;padding:24px}input,button{width:100%;box-sizing:border-box;padding:12px;margin-top:12px}button{background:#111;color:#fff;border:0}</style><h1>Autorizar Claude Code — Kaiso</h1><p>Digite a senha BRIDGE_ACCESS_TOKEN salva no Render.</p><form method="post">${hidden}<input type="password" name="bridge_key" required><button>Autorizar</button></form></html>`);
});
app.post("/oauth/authorize", (req, res) => {
  const a=Buffer.from(String(req.body.bridge_key??"")), b=Buffer.from(bridgeSecret());
  if (a.length!==b.length || !timingSafeEqual(a,b)) { res.status(401).send("Senha inválida"); return; }
  const redirect=String(req.body.redirect_uri??""); if(!safeRedirect(redirect)){res.status(400).send("Redirect inválido");return;}
  const code=sign({kind:"code",exp:Math.floor(Date.now()/1000)+300,client_id:String(req.body.client_id),redirect_uri:redirect,code_challenge:String(req.body.code_challenge)});
  const target=new URL(redirect); target.searchParams.set("code",code); target.searchParams.set("state",String(req.body.state??"")); res.redirect(target.toString());
});
app.post("/oauth/token", (req,res) => {
  const code=verify(String(req.body.code??""),"code"); const challenge=createHash("sha256").update(String(req.body.code_verifier??"")).digest("base64url");
  if(!code || code.client_id!==req.body.client_id || code.redirect_uri!==req.body.redirect_uri || code.code_challenge!==challenge){res.status(400).json({error:"invalid_grant"});return;}
  res.json({access_token:sign({kind:"access",exp:Math.floor(Date.now()/1000)+2592000,sub:"chatgpt"}),token_type:"Bearer",expires_in:2592000});
});

app.post("/mcp", async (req,res) => {
  if(!requireAuth(req,res))return; const server=mcpServer(); const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
  res.on("close",()=>{void transport.close();void server.close();});
  try{await server.connect(transport);await transport.handleRequest(req,res,req.body);}catch(e){if(!res.headersSent)res.status(500).json({error:e instanceof Error?e.message:"internal_error"});}
});
app.get("/mcp",(req,res)=>{if(requireAuth(req,res))res.status(405).json({error:"method_not_allowed"});});
app.delete("/mcp",(req,res)=>{if(requireAuth(req,res))res.status(405).json({error:"method_not_allowed"});});
const port=Number(process.env.PORT??3000);
app.listen(port,"0.0.0.0",()=>console.log(JSON.stringify({event:"server_started",port,instance:randomUUID()})));
