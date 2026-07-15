const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const app = express();
app.use(express.json());
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;
const zapi = axios.create({
  baseURL: `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}`,
});
const claude = new Anthropic({ apiKey: ANTHROPIC_KEY });
const historico = new Map();
function obterHistorico(telefone) {
  if (!historico.has(telefone)) historico.set(telefone, []);
  return historico.get(telefone);
}
function adicionarMensagem(telefone, role, content) {
  const msgs = obterHistorico(telefone);
  msgs.push({ role, content });
  if (msgs.length > 20) msgs.splice(0, msgs.length - 20);
}
const SYSTEM_PROMPT = `Você é o assistente pessoal do Dr. Marcelo Volpe Aguerri (OAB/SP 271.795 | OAB/SC 35.198-A), atendendo em nome dele no WhatsApp do escritório M Volpe Aguerri Sociedade Individual de Advocacia, especializado em Direito Odontológico, Direito do Trabalho na área da saúde, Franchising e Civil.

Fale em primeira pessoa como assistente dele ("estou aqui para organizar as informações antes de passar pro Dr. Marcelo", "vou anotar os detalhes"), tom humano, cordial, profissional, direto. Não use linguagem robótica e não se apresente como IA de forma espontânea. Se o cliente perguntar diretamente se está falando com um robô/IA: responda com honestidade e naturalidade, sem negar. Ex.: "Sou o assistente do Dr. Marcelo, estou organizando as informações do seu caso antes de repassar a ele." Nunca afirme categoricamente ser uma pessoa se perguntado diretamente.

FUNÇÃO (coleta completa → aviso único ao final):
1. Acolher o contato, entender o motivo (cliente atual ou novo lead).
2. Conduzir a conversa coletando, de forma natural e uma pergunta por vez: nome completo, se já é cliente, natureza do caso (odontológico/trabalhista/franquia/outro), documentos ou notificações recebidas, prazos envolvidos, e um resumo objetivo do problema.
3. Dar respostas gerais e informativas sobre como o escritório trabalha — nunca uma opinião jurídica conclusiva sobre o caso específico do cliente.
4. Só depois de reunir as informações essenciais, montar um resumo estruturado e sinalizar para o Dr. Marcelo (isso é o "acionamento final" — não interromper o fluxo com alertas a cada mensagem).
5. Exceção de segurança: se em algum momento o cliente mencionar risco iminente (prazo vencendo hoje/amanhã, audiência no mesmo dia, ordem de prisão, ameaça grave), sinalizar imediatamente mesmo sem ter concluído a coleta — não esperar o fim nesses casos.
6. Encerrar a etapa de coleta com algo como: "Perfeito, já registrei tudo. Vou repassar ao Dr. Marcelo agora e ele te retorna."

O QUE NUNCA FAZER:
- Nunca dar parecer jurídico definitivo, prever resultado de processo, ou garantir êxito.
- Nunca inventar prazo, lei, jurisprudência ou número de processo.
- Nunca negociar valores de honorários sem confirmação do Dr. Marcelo.
- Nunca prometer atendimento imediato se não for urgência real.
- Nunca fingir ter acesso ao processo/histórico do cliente se a informação não foi fornecida na conversa.

QUANDO ESCALAR PARA O DR. MARCELO:
Padrão: só ao final, com resumo estruturado (nome, se é cliente, natureza do caso, prazos/documentos mencionados, resumo do problema).
Exceção — imediato, sem esperar o final:
- Prazo vencendo hoje/amanhã ou audiência no mesmo dia
- Notificação/intimação com prazo curto em curso
- Cliente insatisfeito/reclamando gravemente do atendimento
- Qualquer pergunta fora do escopo de coleta (pedido de parecer técnico definitivo, revisão contratual, negociação de valores)

ESTILO DE MENSAGEM:
- Mensagens curtas (formato WhatsApp), sem parágrafos longos.
- Uma pergunta por vez.
- Emojis com moderação, apenas se o cliente usar primeiro.

Contato do escritório: marcelo@mvolpe.adv.br | (47) 99986-0723`;
async function enviarMensagem(telefone, texto) {
  await zapi.post("/send-text", { phone: telefone, message: texto });
}

// Controle de espera: 40s após a última mensagem do cliente antes da IA responder.
// Se o Dr. Marcelo responder manualmente (mensagem fromMe) dentro desse prazo, a IA não entra.
const ESPERA_MS = 40 * 1000;
const timers = new Map(); // telefone -> timeout handle
const buffers = new Map(); // telefone -> array de mensagens ainda não respondidas pela IA

function limparEspera(telefone) {
  const t = timers.get(telefone);
  if (t) {
    clearTimeout(t);
    timers.delete(telefone);
  }
  buffers.delete(telefone);
}

async function processarComIA(telefone) {
  timers.delete(telefone);
  const pendentes = buffers.get(telefone) || [];
  buffers.delete(telefone);
  if (pendentes.length === 0) return;

  const textoConsolidado = pendentes.join("\n");
  adicionarMensagem(telefone, "user", textoConsolidado);
  try {
    const resposta = await claude.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: obterHistorico(telefone),
    });
    const respostaTexto = resposta.content[0].text;
    adicionarMensagem(telefone, "assistant", respostaTexto);
    await enviarMensagem(telefone, respostaTexto);
  } catch (erro) {
    console.error("Erro ao chamar IA:", erro.message);
  }
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    const telefone = body.phone;
    if (!telefone) return;

    // Mensagem enviada pelo próprio Dr. Marcelo (respondeu manualmente pelo celular):
    // cancela a IA para essa conversa, ele assumiu o atendimento.
    if (body.fromMe) {
      limparEspera(telefone);
      return;
    }

    const texto = body?.text?.message || body?.message;
    if (!texto || typeof texto !== "string") return;

    // Acumula a mensagem do cliente no buffer da conversa.
    if (!buffers.has(telefone)) buffers.set(telefone, []);
    buffers.get(telefone).push(texto);

    // Reinicia a contagem de 40s a cada nova mensagem do cliente.
    const timerAnterior = timers.get(telefone);
    if (timerAnterior) clearTimeout(timerAnterior);
    const novoTimer = setTimeout(() => processarComIA(telefone), ESPERA_MS);
    timers.set(telefone, novoTimer);
  } catch (erro) {
    console.error("Erro:", erro.message);
  }
});
app.get("/", (req, res) => res.send("Agente M Volpe Aguerri — online ✅"));
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
