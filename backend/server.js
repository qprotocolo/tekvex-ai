// ============================================================
// TEKVEX AI — Backend Principal
// Stack: Node.js + Express + Anthropic Claude API
// Autor: TekVex Engine
// ============================================================

import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const app = express();

// ---------------------------------------------------------------
// SEGURANÇA — Variável de ambiente obrigatória
// A chave da Anthropic NUNCA deve estar escrita no código.
// Ela vive SOMENTE nas variáveis de ambiente do Railway.
// ---------------------------------------------------------------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('ERRO CRÍTICO: ANTHROPIC_API_KEY não definida. Encerrando servidor.');
  process.exit(1); // Mata o processo — não sobe sem a chave
}

// Inicializa o cliente da Anthropic com a chave de ambiente
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---------------------------------------------------------------
// MIDDLEWARES GLOBAIS
// ---------------------------------------------------------------

// CORS — permite requisições do frontend (Vercel/Netlify)
// Em produção, substitua '*' pela URL real do seu frontend
app.use(cors({ origin: '*' }));

// Parser de JSON — necessário para ler req.body
app.use(express.json());

// ---------------------------------------------------------------
// SESSÕES EM MEMÓRIA
// Armazena o histórico de cada conversa por sessionId.
// Cada sessão é um array de mensagens { role, content }.
// ATENÇÃO: em memória = se o servidor reiniciar, as sessões somem.
// Para persistência real, migrar para Supabase na próxima fase.
// ---------------------------------------------------------------
const sessions = new Map();

// Tempo máximo de inatividade de uma sessão: 30 minutos
const SESSION_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------
// SYSTEM PROMPT — Identidade da IA para clínicas
// Este é o núcleo do produto. Define quem a IA é,
// como ela se comporta e qual fluxo ela deve seguir.
// ---------------------------------------------------------------
const SYSTEM_PROMPT = `
Você é a Vex, assistente virtual inteligente de uma clínica médica.
Sua missão é acolher o paciente, entender sua necessidade
e conduzi-lo ao agendamento de forma natural e empática.

FLUXO OBRIGATÓRIO — siga esta ordem sem pular etapas:
1. Saudar o paciente com calor e profissionalismo
2. Perguntar o motivo da consulta ou dúvida
3. Coletar o nome completo do paciente
4. Coletar o telefone ou WhatsApp
5. Perguntar o horário de preferência
6. Confirmar os dados e informar que a equipe entrará em contato

REGRAS ABSOLUTAS:
- Nunca invente informações médicas ou diagnósticos
- Nunca prometa horários específicos sem confirmação da clínica
- Sempre use o nome do paciente após coletá-lo
- Seja empática, clara e objetiva
- Se perguntarem algo fora do escopo médico, redirecione gentilmente
- Quando tiver nome + telefone coletados, sinalize que o agendamento será encaminhado

DADOS COLETADOS — quando tiver nome E telefone, inclua ao final da sua resposta,
em linha separada, exatamente neste formato (para o sistema processar):
[LEAD: nome=<nome>, telefone=<telefone>]
`;

// ---------------------------------------------------------------
// ROTA DE SAÚDE — GET /
// Usada pelo Railway e pelo frontend para verificar se o
// servidor está vivo. Retorna status 200 com mensagem simples.
// ---------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'TekVex AI Backend' });
});

// ---------------------------------------------------------------
// ROTA PRINCIPAL — POST /chat
// Recebe mensagem do usuário, mantém histórico da sessão,
// chama Claude e retorna a resposta da IA.
// ---------------------------------------------------------------
app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  // --- Validação de entrada ---
  if (!message || typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ error: 'Campo "message" é obrigatório e deve ser texto.' });
  }

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Campo "sessionId" é obrigatório.' });
  }

  // --- Recupera ou cria sessão para este usuário ---
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { messages: [], createdAt: Date.now() });
  }

  const session = sessions.get(sessionId);

  // --- Segurança: bloqueia sessões muito antigas ---
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return res.status(410).json({ error: 'Sessão expirada. Recarregue o chat.' });
  }

  // --- Adiciona mensagem do usuário ao histórico ---
  session.messages.push({ role: 'user', content: message.trim() });

  try {
    // --- Chama a API da Anthropic com histórico completo ---
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',  // Modelo mais recente e eficiente
      max_tokens: 1024,                    // Limite de tokens por resposta
      system: SYSTEM_PROMPT,              // Identidade e regras da IA
      messages: session.messages          // Histórico completo da sessão
    });

    const reply = response.content[0].text;

    // --- Adiciona resposta da IA ao histórico ---
    session.messages.push({ role: 'assistant', content: reply });

    // --- Detecta se lead foi coletado nesta resposta ---
    // O system prompt instrui a IA a incluir [LEAD: ...] quando tiver dados
    const leadDetected = reply.includes('[LEAD:');

    // --- Retorna resposta para o frontend ---
    return res.json({
      reply,
      leadDetected  // Frontend usa isso para exibir botão de WhatsApp
    });

  } catch (error) {
    // --- Tratamento de erros da API da Anthropic ---
    console.error('Erro ao chamar Anthropic API:', error.message);
    return res.status(502).json({
      error: 'Falha ao processar resposta da IA. Tente novamente.'
    });
  }
});

// ---------------------------------------------------------------
// INICIALIZAÇÃO DO SERVIDOR
// Railway injeta a PORT automaticamente via variável de ambiente.
// ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`TekVex AI Backend rodando na porta ${PORT}`);
});
