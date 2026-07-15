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

FUNÇÃO (coleta rápida e direta → aviso único ao final):
1. Acolher o contato de forma breve, entender o motivo (cliente atual ou novo lead).
2. Ser direto: sem rodeios, sem mensagens de preenchimento. Ir direto às perguntas necessárias, uma por vez, sem enrolação, para chegar rápido ao ponto de repasse ao Dr. Marcelo.
3. Coletar apenas o essencial: nome completo, se já é cliente, natureza do caso (odontológico/trabalhista/franquia/outro), documentos ou notificações recebidas, prazos envolvidos, e um resumo objetivo do problema.
4. Dar respostas gerais e informativas sobre como o escritório trabalha — nunca uma opinião jurídica conclusiva sobre o caso específico do cliente.
5. Só depois de reunir as informações essenciais, montar um resumo estruturado e sinalizar para o Dr. Marcelo (isso é o "acionamento final" — não interromper o fluxo com alertas a cada mensagem).
6. Exceção de segurança: se em algum momento o cliente mencionar risco iminente (prazo vencendo hoje/amanhã, audiência no mesmo dia, ordem de prisão, ameaça grave), sinalizar imediatamente mesmo sem ter concluído a coleta — não esperar o fim nesses casos.
7. Encerrar a etapa de coleta com algo como: "Perfeito, já registrei tudo. Vou repassar ao Dr. Marcelo agora e ele te retorna. Ele pode estar em reunião, audiência ou atendimento no momento, mas retorna assim que possível."

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

SE O CLIENTE PERGUNTAR SOBRE DEMORA NO RETORNO:
Informe que o Dr. Marcelo pode estar em reunião, audiência ou atendimento no momento, mas que o retorno acontece assim que possível. Não dê prazo específico.

ESTILO DE MENSAGEM:
- Seja extremamente breve. Frases curtas, direto ao ponto, sem rodeios nem explicações desnecessárias.
- Uma pergunta por vez, uma frase por vez sempre que possível.
- Nunca use emojis, em hipótese alguma, mesmo que o cliente use.

Contato do escritório: marcelo@mvolpe.adv.br | (47) 99986-0723`;
async function enviarMensagem(telefone, texto) {
  await zapi.post("/send-text", { phone: telefone, message: texto });
}

// Regras de tempo:
// - Primeira mensagem de uma conversa/retomada: aguarda 10s antes da IA responder
//   (dá chance do Dr. Marcelo responder manualmente primeiro).
// - Mensagens seguintes (dentro da mesma sessão ativa da IA): resposta instantânea.
// - Se o Dr. Marcelo enviar qualquer mensagem manualmente (fromMe), a IA para de atuar
//   nessa conversa e só volta a responder automaticamente depois de 60 minutos
//   sem nenhuma nova interação manual dele.
const ESPERA_PRIMEIRA_MS = 120 * 1000;
const PAUSA_MARCELO_MS = 60 * 60 * 1000;

const timers = new Map(); // telefone -> timeout handle
const buffers = new Map(); // telefone -> array de mensagens ainda não respondidas pela IA
const aguardandoPrimeira = new Map(); // telefone -> boolean (true = próxima resposta usa espera de 10s)
const pausadoAte = new Map(); // telefone -> timestamp (ms) até quando a IA fica pausada

function iaEstaPausada(telefone) {
  const ate = pausadoAte.get(telefone);
  return !!ate && Date.now() < ate;
}

function cancelarRespostaPendente(telefone) {
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
  if (iaEstaPausada(telefone)) return; // Dr. Marcelo voltou a interagir enquanto esperava

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
    aguardandoPrimeira.set(telefone, false); // próximas mensagens são instantâneas
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
    // cancela qualquer resposta pendente da IA e pausa o agente por 30 minutos.
    if (body.fromMe) {
      cancelarRespostaPendente(telefone);
      pausadoAte.set(telefone, Date.now() + PAUSA_MARCELO_MS);
      aguardandoPrimeira.set(telefone, true); // ao retomar, trata como "primeira mensagem" de novo
      return;
    }

    const texto = body?.text?.message || body?.message;
    if (!texto || typeof texto !== "string") return;

    if (iaEstaPausada(telefone)) return; // Dr. Marcelo assumiu a conversa recentemente

    // Acumula a mensagem do cliente no buffer da conversa.
    if (!buffers.has(telefone)) buffers.set(telefone, []);
    buffers.get(telefone).push(texto);

    const ehPrimeira = aguardandoPrimeira.get(telefone) !== false; // default true
    const espera = ehPrimeira ? ESPERA_PRIMEIRA_MS : 0;

    const timerAnterior = timers.get(telefone);
    if (timerAnterior) clearTimeout(timerAnterior);

    if (espera === 0) {
      // Resposta instantânea: processa direto, sem agendar timeout.
      processarComIA(telefone);
    } else {
      const novoTimer = setTimeout(() => processarComIA(telefone), espera);
      timers.set(telefone, novoTimer);
    }
  } catch (erro) {
    console.error("Erro:", erro.message);
  }
});
app.get("/", (req, res) => res.send("Agente M Volpe Aguerri — online ✅"));
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
