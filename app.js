/* RADIOPEER — ferramenta de aprendizado para residentes de radiologia.
   Tudo roda neste navegador: nenhum laudo é enviado a servidor. */
'use strict';

const PROMPT_VERSION = 'v1';
const RP_ORDEM = { '1': 0, '2a': 1, '2b': 2, '3a': 3, '3b': 4 };

/* ===================== util ===================== */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const uuid = () => crypto.randomUUID();

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function semAcento(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function norm(s) {
  return semAcento(s).toUpperCase().replace(/\s+/g, ' ').trim();
}
async function sha256(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function rpClasse(rp) {
  if (!rp) return '';
  if (rp === '1') return 'g1';
  return rp.startsWith('2') ? 'g2' : 'g3';
}
function hoje() { return new Date().toISOString(); }
function fmtData(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleDateString('pt-BR');
}
function parseDataBr(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s || '').trim());
  return m ? new Date(+m[3], +m[2] - 1, +m[1]).toISOString() : null;
}

/* ===================== banco ===================== */
const db = new Dexie('radiopeer');
db.version(1).stores({
  laudos: 'id, tipo, hash, chave',
  pares: 'id, status',
  config: 'key'
});

const SEGMENTOS_PADRAO = [
  'Joelho: joelho',
  'Ombro: ombro',
  'Tornozelo/Pé: tornozelo, pe, antepe, retrope',
  'Quadril: quadril, bacia, coxofemoral',
  'Coluna: coluna, cervical, lombar, toracica, dorsal, lombossacra',
  'Punho/Mão: punho, mao, dedo',
  'Cotovelo: cotovelo, antebraco',
  'Coxa/Perna: coxa, perna, femur, tibia',
  'Desfiladeiro torácico: desfiladeiro',
  'Plexo braquial: plexo braquial',
  'Plexo sacral: plexo sacral, plexo lombossacral',
  'Crânio/Encéfalo: cranio, encefalo, cerebro, sela, orbitas, ouvido, mastoide',
  'Face/Pescoço: face, seios da face, pescoco, tireoide, atm',
  'Tórax: torax, pulmao, mediastino',
  'Abdome: abdome, abdomen, figado, pancreas, rins, vias biliares, enterografia',
  'Pelve: pelve, prostata, utero, reto, sacroiliacas',
  'Mama: mama, mamografia',
  'Vascular: angio, aorta, carotidas, arterias, veias'
];

let CFG = {};
async function carregarConfig() {
  const linhas = await db.config.toArray();
  const kv = Object.fromEntries(linhas.map(l => [l.key, l.value]));
  CFG = {
    modo: kv.modo || 'assistido',
    provider: kv.provider || 'claude',
    apiKey: kv.apiKey || '',
    model: kv.model || '',
    baseUrl: kv.baseUrl || '',
    anonimizar: kv.anonimizar || false,
    segmentos: kv.segmentos || SEGMENTOS_PADRAO.join('\n')
  };
}
async function salvarConfig(patch) {
  Object.assign(CFG, patch);
  await db.config.bulkPut(Object.entries(patch).map(([key, value]) => ({ key, value })));
}

/* ===================== extração de texto ===================== */
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}
async function extrairPdf(buf) {
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const partes = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    let linha = [], linhas = [], lastY = null;
    for (const item of tc.items) {
      const y = Math.round(item.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 4) { linhas.push(linha.join(' ')); linha = []; }
      linha.push(item.str);
      lastY = y;
    }
    if (linha.length) linhas.push(linha.join(' '));
    partes.push(linhas.join('\n'));
  }
  return partes.join('\n\n');
}
async function extrairDocx(buf) {
  const r = await mammoth.extractRawText({ arrayBuffer: buf });
  return r.value || '';
}
async function extrairArquivo(nome, buf) {
  const ext = nome.toLowerCase().split('.').pop();
  if (ext === 'pdf') return extrairPdf(buf);
  if (ext === 'docx' || ext === 'doc') return extrairDocx(buf);
  return new TextDecoder('utf-8').decode(buf);
}

/* ===================== metadados do laudo ===================== */
const ABREV = [
  [/\bRESSONANCIA( MAGNETICA)?( NUCLEAR)?\b/g, 'RM'],
  [/\bTOMOGRAFIA( COMPUTADORIZADA)?\b/g, 'TC'],
  [/\bRADIOGRAFIA\b/g, 'RX'],
  [/\bULTRASSONOGRAFIA\b|\bULTRA-?SOM\b|\bECOGRAFIA\b/g, 'US'],
  [/\bDIREITA?O?\b|\bDIR\.?\b|\b[AÀ] DIREITA\b|\bD\b$/g, 'DIREITO'],
  [/\bESQUERDA?O?\b|\bESQ\.?\b|\b[AÀ] ESQUERDA\b|\bE\b$/g, 'ESQUERDO'],
  [/\bARTIC\.?\b|\bARTICULACAO( DO| DE)?\b/g, ''],
  [/\bDO\b|\bDA\b|\bDE\b|\bDOS\b|\bDAS\b/g, ''],
  [/\bEXAME\b|\bLAUDO\b/g, '']
];
function normTitulo(t) {
  let s = norm(t);
  for (const [re, sub] of ABREV) s = s.replace(re, sub);
  return s.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
const RE_MODALIDADE = /(RM|RESSONANCIA|TC|TOMOGRAFIA|RX|RADIOGRAFIA|US|ULTRASSONOGRAFIA|ULTRA-?SOM|ECOGRAFIA|MAMOGRAFIA|DENSITOMETRIA|ANGIO)/i;

function extrairMeta(texto) {
  const linhas = texto.split('\n').map(l => l.trim());
  const cab = linhas.slice(0, 25);
  const rod = linhas.slice(-18);
  const meta = { nome: '', pacienteId: '', titulo: '', dataExame: null, liberadoPor: '' };

  for (const l of cab) {
    const sa = semAcento(l);
    let m;
    if (!meta.nome && (m = /(?:PACIENTE|NOME(?:\s+DO\s+PACIENTE)?)\s*[:\-]\s*(.{3,70})/i.exec(sa))) {
      meta.nome = m[1].replace(/\b(ID|REGISTRO|DATA|SEXO|IDADE|CONVENIO)\b.*$/i, '').trim();
    }
    if (!meta.pacienteId && (m = /(?:ID|REGISTRO|PRONTUARIO|MATRICULA|CODIGO|OS|ACESSO|ACCESSION)\s*[:\-]?\s*(\d{3,})/i.exec(sa))) {
      meta.pacienteId = m[1];
    }
    if (!meta.dataExame && (m = /(\d{2}\/\d{2}\/\d{4})/.exec(l))) {
      meta.dataExame = parseDataBr(m[1]);
    }
    if (!meta.titulo) {
      if ((m = /(?:EXAME|PROCEDIMENTO)\s*[:\-]\s*(.{3,80})/i.exec(sa))) meta.titulo = m[1].trim();
      else if (RE_MODALIDADE.test(sa) && sa.length < 90 && !/PACIENTE|NOME|MEDICO|SOLICITANTE/i.test(sa)) meta.titulo = l;
    }
  }
  for (let i = rod.length - 1; i >= 0; i--) {
    const sa = semAcento(rod[i]);
    let m;
    if ((m = /(DR\.?A?\.?\s+[A-Za-z][A-Za-z .]{3,50})/i.exec(sa)) || (m = /([A-Z][A-Za-z .]{4,50})\s*[-–]?\s*CRM/i.exec(sa))) {
      meta.liberadoPor = m[1].replace(/\s+/g, ' ').trim();
      break;
    }
  }
  if (!meta.titulo) {
    const l = linhas.find(x => RE_MODALIDADE.test(semAcento(x)));
    if (l) meta.titulo = l;
  }
  return meta;
}

function chaveLaudo(l) {
  const quem = l.pacienteId || norm(l.nome) || '?';
  return quem + '|' + normTitulo(l.titulo || '');
}

/* ===================== ingestão ===================== */
async function ingerirArquivos(fileList, tipo) {
  const arquivos = [];
  for (const f of fileList) {
    if (f.name.toLowerCase().endsWith('.zip')) {
      try {
        const zip = await JSZip.loadAsync(await f.arrayBuffer());
        for (const [nome, entry] of Object.entries(zip.files)) {
          if (entry.dir) continue;
          if (!/\.(pdf|docx|doc|txt)$/i.test(nome)) continue;
          arquivos.push({ nome: nome.split('/').pop(), buf: await entry.async('arraybuffer') });
        }
      } catch (e) { toast('ZIP inválido: ' + f.name); }
    } else {
      arquivos.push({ nome: f.name, buf: await f.arrayBuffer() });
    }
  }
  let novos = 0, repetidos = 0, falhas = 0;
  for (const a of arquivos) {
    try {
      const hash = await sha256(a.buf);
      const existe = await db.laudos.where('hash').equals(hash).first();
      if (existe) { repetidos++; continue; }
      const texto = (await extrairArquivo(a.nome, a.buf)).trim();
      if (!texto || texto.length < 30) { falhas++; continue; }
      const meta = extrairMeta(texto);
      const laudo = {
        id: uuid(), tipo, hash, fileName: a.nome, texto,
        nome: meta.nome, pacienteId: meta.pacienteId, titulo: meta.titulo || a.nome.replace(/\.[^.]+$/, ''),
        dataExame: meta.dataExame, liberadoPor: meta.liberadoPor,
        chave: '', importadoEm: hoje()
      };
      laudo.chave = chaveLaudo(laudo);
      await db.laudos.add(laudo);
      novos++;
    } catch (e) { console.error(e); falhas++; }
  }
  await parearAutomatico();
  await renderTudo();
  let msg = `${novos} laudo(s) importado(s)`;
  if (repetidos) msg += `, ${repetidos} repetido(s) ignorado(s)`;
  if (falhas) msg += `, ${falhas} falha(s) de leitura`;
  toast(msg);
}

/* ===================== pareamento ===================== */
async function idsEmPares() {
  const pares = await db.pares.toArray();
  const usados = new Set();
  for (const p of pares) { usados.add(p.preId); if (p.oficialId) usados.add(p.oficialId); }
  return { pares, usados };
}
async function parearAutomatico() {
  const laudos = await db.laudos.toArray();
  const { usados } = await idsEmPares();
  const pres = laudos.filter(l => l.tipo === 'pre' && !usados.has(l.id));
  const ofs = laudos.filter(l => l.tipo === 'oficial' && !usados.has(l.id));
  const porChave = new Map();
  for (const o of ofs) {
    if (!porChave.has(o.chave)) porChave.set(o.chave, []);
    porChave.get(o.chave).push(o);
  }
  for (const p of pres) {
    const cands = porChave.get(p.chave) || [];
    if (!cands.length) continue;
    let cand = cands[0];
    if (cands.length > 1 && p.dataExame) {
      cand = cands.find(c => c.dataExame && c.dataExame.slice(0, 10) === p.dataExame.slice(0, 10)) || cands[0];
    }
    porChave.set(p.chave, cands.filter(c => c.id !== cand.id));
    await db.pares.add({ id: uuid(), preId: p.id, oficialId: cand.id, status: 'pronto', criadoEm: hoje() });
  }
}
async function parearManual(laudoId, outroId) {
  const a = await db.laudos.get(laudoId);
  const b = await db.laudos.get(outroId);
  if (!a || !b) return;
  const pre = a.tipo === 'pre' ? a : b;
  const of = a.tipo === 'pre' ? b : a;
  await db.pares.add({ id: uuid(), preId: pre.id, oficialId: of.id, status: 'pronto', criadoEm: hoje(), manual: true });
  await renderTudo();
  toast('Par criado.');
}
async function desfazerPar(parId) {
  await db.pares.delete(parId);
  await parearAutomatico();
  await renderTudo();
  toast('Par desfeito.');
}

/* ===================== prompt e análise ===================== */
function anonimizar(texto, laudo) {
  let t = texto;
  if (laudo.nome && laudo.nome.length > 3) t = t.split(laudo.nome).join('[PACIENTE]');
  if (laudo.pacienteId) t = t.split(laudo.pacienteId).join('[ID]');
  return t;
}

function montarPrompt(itens) {
  const casos = itens.map(it => {
    const pre = CFG.anonimizar ? anonimizar(it.pre.texto, it.pre) : it.pre.texto;
    const of = CFG.anonimizar ? anonimizar(it.oficial.texto, it.oficial) : it.oficial.texto;
    return `### CASO ${it.par.id}\nEXAME: ${it.pre.titulo}\n\n--- PRÉ-LAUDO (residente) ---\n${pre}\n\n--- LAUDO OFICIAL (staff) ---\n${of}`;
  }).join('\n\n');

  return `Você é um radiologista preceptor experiente. Compare cada PRÉ-LAUDO de residente com o LAUDO OFICIAL correspondente e produza uma avaliação pedagógica estruturada.

Para CADA caso identifique:
1. DISCREPÂNCIAS — cada uma como um achado individual com:
   - "titulo": resumo curto do achado discrepante
   - "tipo": "omissao" (só no oficial), "adicional" (só no pré-laudo) ou "divergencia" (interpretações diferentes do mesmo achado)
   - "macro": "percepcao" (não viu), "interpretacao" (viu e concluiu errado) ou "comunicacao" (viu/concluiu certo mas relatou mal ou não relatou)
   - "subtipo": classificação de Kim–Mansfield quando aplicável ("under-reading", "satisfacao de busca", "raciocinio incorreto", "localizacao", "satisfacao de laudo", "falha em consultar previo", "tecnica", "outro")
   - "radpeer": escala ACR 2016 — "1" concordância; "2a"/"2b" discrepância difícil (nem sempre seria diagnosticada); "3a"/"3b" discrepância que deveria ser diagnosticada na maioria das vezes; sufixo "a" = provavelmente SEM significância clínica, "b" = provavelmente COM significância clínica
   - "justificativa": por que importa clinicamente + dica de leitura para não repetir (teaching point)
   - "trecho_pre": citação EXATA e curta do pré-laudo relacionada (ou "" se ausente)
   - "trecho_oficial": citação EXATA e curta do laudo oficial relacionada (ou "" se ausente)
2. GREAT CALLS — achados difíceis/sutis que o residente ACERTOU: {"titulo","descricao","trecho"} (trecho = citação exata do pré-laudo)
3. RUBRICA de estilo do pré-laudo, notas 1 a 5: {"estrutura","terminologia","clareza","concisao"}
4. SUGESTOES — até 3 recomendações práticas de leitura e redação
5. "resumo" — 1 frase sobre o desempenho no caso

REGRAS:
- As citações em trecho_pre/trecho_oficial devem ser cópias literais de trechos dos textos.
- Se os laudos concordam plenamente, retorne "achados": [] .
- Responda APENAS com JSON válido, sem texto antes ou depois, neste formato:

[
  {
    "caso": "<id do caso>",
    "achados": [ { "titulo":"", "tipo":"", "macro":"", "subtipo":"", "radpeer":"", "justificativa":"", "trecho_pre":"", "trecho_oficial":"" } ],
    "great_calls": [ { "titulo":"", "descricao":"", "trecho":"" } ],
    "rubrica": { "estrutura":0, "terminologia":0, "clareza":0, "concisao":0 },
    "sugestoes": [""],
    "resumo": ""
  }
]

${casos}`;
}

function extrairJson(texto) {
  let t = texto.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1].trim();
  const ini = t.indexOf('[');
  if (ini === -1) {
    const iniObj = t.indexOf('{');
    if (iniObj === -1) throw new Error('Nenhum JSON encontrado na resposta.');
    t = '[' + t.slice(iniObj, t.lastIndexOf('}') + 1) + ']';
  } else {
    t = t.slice(ini, t.lastIndexOf(']') + 1);
  }
  try { return JSON.parse(t); }
  catch (e) {
    const fim = t.lastIndexOf('},');
    if (fim > 0) {
      try { return JSON.parse(t.slice(0, fim + 1) + ']'); } catch (e2) { /* segue */ }
    }
    throw new Error('JSON malformado — copie a resposta completa do chat.');
  }
}

function normalizarAnalise(item) {
  const achados = (item.achados || []).map(a => ({
    titulo: String(a.titulo || 'Achado'),
    tipo: ['omissao', 'adicional', 'divergencia'].includes(a.tipo) ? a.tipo : 'divergencia',
    macro: ['percepcao', 'interpretacao', 'comunicacao'].includes(a.macro) ? a.macro : 'interpretacao',
    subtipo: String(a.subtipo || 'outro'),
    radpeer: RP_ORDEM[a.radpeer] !== undefined ? a.radpeer : '2a',
    justificativa: String(a.justificativa || ''),
    trecho_pre: String(a.trecho_pre || ''),
    trecho_oficial: String(a.trecho_oficial || ''),
    status: 'pendente'
  }));
  const rub = item.rubrica || {};
  const notas = {};
  for (const k of ['estrutura', 'terminologia', 'clareza', 'concisao']) {
    const v = Number(rub[k]);
    notas[k] = (v >= 1 && v <= 5) ? v : null;
  }
  return {
    achados,
    greatCalls: (item.great_calls || []).map(g => ({ titulo: String(g.titulo || 'Great call'), descricao: String(g.descricao || ''), trecho: String(g.trecho || '') })),
    rubrica: notas,
    sugestoes: (item.sugestoes || []).map(String).slice(0, 5),
    resumo: String(item.resumo || '')
  };
}

function radpeerGeral(analise) {
  let pior = '1';
  for (const a of analise.achados) {
    if (a.status === 'rejeitado' || a.status === 'discussao') continue;
    if (RP_ORDEM[a.radpeer] > RP_ORDEM[pior]) pior = a.radpeer;
  }
  return pior;
}

async function salvarAnalises(lista) {
  let salvos = 0; const idsSalvos = [];
  for (const item of lista) {
    const par = await db.pares.get(String(item.caso || ''));
    if (!par) continue;
    const analise = normalizarAnalise(item);
    par.analise = analise;
    par.radpeerGeral = radpeerGeral(analise);
    par.status = 'analisado';
    par.analisadoEm = hoje();
    par.promptVersion = PROMPT_VERSION;
    await db.pares.put(par);
    salvos++; idsSalvos.push(par.id);
  }
  return { salvos, idsSalvos };
}

async function filaPendente() {
  const pares = await db.pares.where('status').equals('pronto').toArray();
  const itens = [];
  for (const par of pares) {
    const pre = await db.laudos.get(par.preId);
    const oficial = await db.laudos.get(par.oficialId);
    if (pre && oficial) itens.push({ par, pre, oficial });
  }
  return itens;
}

/* ===================== modo API ===================== */
async function chamarIA(prompt) {
  const model = CFG.model.trim();
  if (CFG.provider === 'claude') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': CFG.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({ model: model || 'claude-sonnet-5', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] })
    });
    if (!r.ok) throw new Error('Claude HTTP ' + r.status + ': ' + (await r.text()).slice(0, 300));
    const j = await r.json();
    return j.content.map(c => c.text || '').join('');
  }
  if (CFG.provider === 'gemini') {
    const m = model || 'gemini-2.5-flash';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(CFG.apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    if (!r.ok) throw new Error('Gemini HTTP ' + r.status + ': ' + (await r.text()).slice(0, 300));
    const j = await r.json();
    return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  }
  // compatível com OpenAI
  const base = (CFG.baseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('Informe a URL base do endpoint compatível.');
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + CFG.apiKey },
    body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  return j.choices?.[0]?.message?.content || '';
}

async function rodarFilaAPI() {
  const btn = $('#btn-rodar-api');
  btn.disabled = true;
  try {
    let itens = await filaPendente();
    if (!itens.length) { toast('Fila vazia.'); return; }
    let feitos = 0;
    for (const it of itens) {
      $('#api-progresso').textContent = `analisando ${feitos + 1} de ${itens.length}…`;
      try {
        const resposta = await chamarIA(montarPrompt([it]));
        const lista = extrairJson(resposta);
        if (lista[0]) lista[0].caso = it.par.id;
        await salvarAnalises(lista);
        feitos++;
      } catch (e) {
        console.error(e);
        $('#api-msg').textContent = 'Erro em "' + it.pre.titulo + '": ' + e.message;
      }
      await renderAnalise();
    }
    $('#api-progresso').textContent = '';
    toast(`${feitos} par(es) analisado(s).`);
    await renderTudo();
    if (feitos) irParaResultado();
  } finally { btn.disabled = false; }
}

/* ===================== navegação ===================== */
function show(id) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === id));
  $$('.rail button').forEach(b => b.classList.toggle('active', b.dataset.view === id));
  if (id === 'v-pares') renderPares();
  if (id === 'v-analise') renderAnalise();
  if (id === 'v-result') renderResultado();
  if (id === 'v-evolucao') renderEvolucao();
  if (id === 'v-checklist') renderChecklist();
  if (id === 'v-config') renderConfig();
}

/* ===================== render: enviar ===================== */
async function renderEnviar() {
  const laudos = await db.laudos.toArray();
  for (const tipo of ['pre', 'oficial']) {
    const cont = $(tipo === 'pre' ? '#files-pre' : '#files-oficial');
    const meus = laudos.filter(l => l.tipo === tipo).slice(-8);
    cont.innerHTML = meus.map(l =>
      `<span class="filechip"><span class="ext">${esc(l.fileName.split('.').pop().toUpperCase())}</span><span class="nm">${esc(l.fileName)}</span></span>`
    ).join('');
  }
  const nPre = laudos.filter(l => l.tipo === 'pre').length;
  const nOf = laudos.filter(l => l.tipo === 'oficial').length;
  $('#enviar-status').textContent = nPre || nOf ? `${nPre} pré-laudo(s) · ${nOf} oficial(is)` : 'nenhuma configuração necessária — modo assistido ativo';
}

/* ===================== render: pares ===================== */
async function renderPares() {
  const laudos = await db.laudos.toArray();
  const porId = new Map(laudos.map(l => [l.id, l]));
  const { pares, usados } = await idsEmPares();
  const orfaos = laudos.filter(l => !usados.has(l.id));

  const busca = norm($('#busca-pares').value || '');
  const filtro = $('#filtro-pares').value;

  const linhas = [];
  for (const p of pares.sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''))) {
    const pre = porId.get(p.preId), of = porId.get(p.oficialId);
    if (!pre) continue;
    const paciente = pre.nome || pre.pacienteId || '—';
    const txt = norm(paciente + ' ' + pre.titulo);
    if (busca && !txt.includes(busca)) continue;
    const st = p.status === 'analisado' && p.temDiscussao ? 'discussao' : p.status;
    if (filtro && filtro !== st && !(filtro === 'analisado' && p.status === 'analisado')) continue;
    const pillMap = { analisado: ['done', 'Analisado'], pronto: ['ready', 'Pronto p/ analisar'] };
    const disc = p.analise && p.analise.achados.some(a => a.status === 'discussao');
    const pill = disc ? `<span class="pill disc">P/ discussão</span>` : `<span class="pill ${pillMap[p.status]?.[0] || 'ready'}">${pillMap[p.status]?.[1] || p.status}</span>`;
    const rp = p.status === 'analisado' ? `<span class="rp ${rpClasse(p.radpeerGeral)}">${p.radpeerGeral}</span>` : '—';
    const acoes = [
      p.status === 'analisado' ? `<a class="go acao" data-ver="${p.id}">Ver resultado →</a>` : '',
      `<a class="go acao" data-editar="${pre.id}">Editar</a>`,
      `<a class="go acao" data-desfazer="${p.id}">Desfazer par</a>`
    ].join('');
    linhas.push(`<tr><td>${esc(paciente)}</td><td>${esc(pre.titulo)}</td><td>${fmtData(pre.dataExame)}</td><td>${esc(of?.liberadoPor || of?.fileName || '—')}</td><td>${pill}</td><td>${rp}</td><td>${acoes}</td></tr>`);
  }
  for (const l of orfaos) {
    const paciente = l.nome || l.pacienteId || '—';
    const txt = norm(paciente + ' ' + l.titulo);
    if (busca && !txt.includes(busca)) continue;
    if (filtro && filtro !== 'sem_par') continue;
    const falta = l.tipo === 'pre' ? 'falta oficial' : 'falta pré-laudo';
    linhas.push(`<tr><td>${esc(paciente)}</td><td>${esc(l.titulo)}</td><td>${fmtData(l.dataExame)}</td><td>${esc(l.liberadoPor || '—')}</td><td><span class="pill orphan">Sem par (${falta})</span></td><td>—</td><td><a class="go acao" data-parear="${l.id}">Parear manualmente</a><a class="go acao" data-editar="${l.id}">Editar</a><a class="go acao" data-excluir="${l.id}">Excluir</a></td></tr>`);
  }
  $('#tbody-pares').innerHTML = linhas.join('');
  $('#pares-vazio').style.display = linhas.length ? 'none' : 'block';
  const nAna = pares.filter(p => p.status === 'analisado').length;
  const nPronto = pares.filter(p => p.status === 'pronto').length;
  $('#pares-resumo').textContent = `${nAna} analisado(s) · ${nPronto} pronto(s) · ${orfaos.length} sem par`;
  $('#btn-analisar-todos').textContent = `Analisar prontos (${nPronto})`;
  $('#btn-analisar-todos').disabled = !nPronto;
}

/* editar laudo */
async function abrirEditar(laudoId) {
  const l = await db.laudos.get(laudoId);
  if (!l) return;
  $('#ed-nome').value = l.nome || '';
  $('#ed-id').value = l.pacienteId || '';
  $('#ed-titulo').value = l.titulo || '';
  $('#ed-data').value = l.dataExame ? fmtData(l.dataExame) : '';
  $('#ed-liberou').value = l.liberadoPor || '';
  $('#ed-tipo').value = l.tipo;
  const dlg = $('#dlg-editar');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', async function h() {
    dlg.removeEventListener('close', h);
    if (dlg.returnValue !== 'ok') return;
    l.nome = $('#ed-nome').value.trim();
    l.pacienteId = $('#ed-id').value.trim();
    l.titulo = $('#ed-titulo').value.trim();
    l.dataExame = parseDataBr($('#ed-data').value) || l.dataExame;
    l.liberadoPor = $('#ed-liberou').value.trim();
    l.tipo = $('#ed-tipo').value;
    l.chave = chaveLaudo(l);
    await db.laudos.put(l);
    await parearAutomatico();
    await renderTudo();
    toast('Laudo atualizado.');
  });
}

/* parear manualmente */
async function abrirParear(laudoId) {
  const l = await db.laudos.get(laudoId);
  if (!l) return;
  const laudos = await db.laudos.toArray();
  const { usados } = await idsEmPares();
  const tipoOposto = l.tipo === 'pre' ? 'oficial' : 'pre';
  const cands = laudos.filter(x => x.tipo === tipoOposto && !usados.has(x.id));
  if (!cands.length) { toast('Nenhum laudo ' + (tipoOposto === 'pre' ? 'pré' : 'oficial') + ' sem par disponível.'); return; }
  $('#parear-com').textContent = `${l.titulo} — ${l.nome || l.pacienteId || l.fileName}`;
  $('#sel-parear').innerHTML = cands.map(c =>
    `<option value="${c.id}">${esc(c.titulo)} — ${esc(c.nome || c.pacienteId || c.fileName)} (${fmtData(c.dataExame)})</option>`
  ).join('');
  const dlg = $('#dlg-parear');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', async function h() {
    dlg.removeEventListener('close', h);
    if (dlg.returnValue !== 'ok') return;
    await parearManual(l.id, $('#sel-parear').value);
  });
}

/* ===================== render: análise ===================== */
async function renderAnalise() {
  const pares = await db.pares.toArray();
  const prontos = pares.filter(p => p.status === 'pronto');
  const analisados = pares.filter(p => p.status === 'analisado');
  const total = prontos.length + analisados.length;
  $('#fila-bar').style.width = total ? Math.round(100 * analisados.length / total) + '%' : '0%';
  $('#analise-status').textContent = `${analisados.length} de ${total} pares analisados · anonimização: ${CFG.anonimizar ? 'ligada' : 'desligada'}`;

  const porId = new Map((await db.laudos.toArray()).map(l => [l.id, l]));
  const li = [];
  for (const p of analisados.slice(-6)) {
    const pre = porId.get(p.preId);
    li.push(`<li>✓ ${esc(pre?.nome || pre?.pacienteId || '')} · ${esc(pre?.titulo || '')} <span class="rp ${rpClasse(p.radpeerGeral)}">${p.radpeerGeral}</span></li>`);
  }
  for (const p of prontos.slice(0, 8)) {
    const pre = porId.get(p.preId);
    li.push(`<li>→ ${esc(pre?.nome || pre?.pacienteId || '')} · ${esc(pre?.titulo || '')} <span class="hint">aguardando</span></li>`);
  }
  if (prontos.length > 8) li.push(`<li class="hint">… mais ${prontos.length - 8} aguardando</li>`);
  if (!li.length) li.push('<li class="hint">Fila vazia — envie laudos na tela Enviar.</li>');
  $('#fila-lista').innerHTML = li.join('');

  const apiOk = CFG.modo === 'api' && CFG.apiKey;
  $('#painel-api').style.display = apiOk ? '' : 'none';
  $('#painel-assistido').style.display = apiOk ? 'none' : '';
  $('#modo-info').textContent = apiOk
    ? 'Modo automático ativo. Para voltar ao modo assistido (copiar/colar), altere nas Configurações.'
    : 'Modo assistido: nenhuma chave ou custo necessário — usa o chat de IA que você já tem. Com chave de API (Configurações), a fila roda sozinha.';
  $('#btn-copiar-prompt').disabled = !prontos.length;
}

let LOTE_ATUAL = [];
async function copiarPrompt() {
  const itens = await filaPendente();
  if (!itens.length) { toast('Fila vazia.'); return; }
  const sel = $('#sel-lote').value;
  LOTE_ATUAL = sel === 'all' ? itens : itens.slice(0, parseInt(sel, 10));
  const prompt = montarPrompt(LOTE_ATUAL);
  try {
    await navigator.clipboard.writeText(prompt);
    $('#assistido-msg').textContent = `Prompt com ${LOTE_ATUAL.length} par(es) copiado! Cole no seu chat de IA, aguarde a resposta completa e cole-a no campo acima.`;
    toast('Prompt copiado para a área de transferência.');
  } catch (e) {
    const ta = $('#resposta-ia');
    ta.value = prompt;
    ta.select();
    $('#assistido-msg').textContent = 'Não consegui copiar automaticamente — o prompt está no campo acima: copie manualmente (Ctrl+C), apague o campo e cole a resposta do chat.';
  }
}
async function validarResposta() {
  const txt = $('#resposta-ia').value.trim();
  if (!txt) { toast('Cole a resposta do chat primeiro.'); return; }
  try {
    const lista = extrairJson(txt);
    const { salvos, idsSalvos } = await salvarAnalises(lista);
    if (!salvos) { $('#assistido-msg').textContent = 'Nenhum caso da resposta corresponde à fila — confira se copiou a resposta certa.'; return; }
    $('#resposta-ia').value = '';
    const restantes = (await filaPendente()).length;
    $('#assistido-msg').textContent = `${salvos} par(es) salvos.` + (restantes ? ` Restam ${restantes} na fila — copie o próximo prompt.` : ' Fila concluída!');
    toast(`${salvos} análise(s) salva(s).`);
    await renderTudo();
    if (!restantes && idsSalvos.length) { RESULT_ID = idsSalvos[0]; show('v-result'); }
  } catch (e) {
    $('#assistido-msg').textContent = '⚠ ' + e.message;
  }
}

/* ===================== render: resultado ===================== */
let RESULT_ID = null;

function marcarTexto(texto, marcas) {
  // marcas: [{trecho, classe}]
  let html = esc(texto);
  const usadas = [];
  for (const m of marcas) {
    const t = (m.trecho || '').trim();
    if (t.length < 6) continue;
    const alvo = esc(t);
    if (html.includes(alvo)) { usadas.push({ alvo, classe: m.classe }); continue; }
    // tenta sem quebras de linha
    const flex = alvo.replace(/\s+/g, ' ');
    const idx = html.replace(/\s+/g, ' ').indexOf(flex);
    if (idx >= 0) usadas.push({ alvo: null, flex, classe: m.classe });
  }
  for (const u of usadas) {
    if (u.alvo) html = html.split(u.alvo).join(`<mark class="${u.classe}">${u.alvo}</mark>`);
  }
  return html;
}

async function listaAnalisados() {
  const pares = (await db.pares.where('status').equals('analisado').toArray())
    .sort((a, b) => (b.analisadoEm || '').localeCompare(a.analisadoEm || ''));
  return pares;
}

async function renderResultado() {
  const pares = await listaAnalisados();
  const vazio = !pares.length;
  $('#res-vazio').style.display = vazio ? 'block' : 'none';
  $('#result-grid').style.display = vazio ? 'none' : '';
  if (vazio) { $('#res-titulo').textContent = '—'; $('#res-meta').textContent = ''; return; }
  if (!RESULT_ID || !pares.find(p => p.id === RESULT_ID)) RESULT_ID = pares[0].id;
  const idx = pares.findIndex(p => p.id === RESULT_ID);
  const par = pares[idx];
  const pre = await db.laudos.get(par.preId);
  const of = await db.laudos.get(par.oficialId);
  const an = par.analise;

  $('#res-titulo').textContent = `${pre.titulo} · ${pre.nome || pre.pacienteId || ''}`;
  $('#res-meta').innerHTML = `par ${idx + 1} de ${pares.length} · ${fmtData(pre.dataExame)} · geral: <span class="rp ${rpClasse(par.radpeerGeral)}">RadPeer ${par.radpeerGeral}</span>`;
  $('#res-quem-pre').textContent = pre.liberadoPor || 'Residente';
  $('#res-quem-oficial').textContent = of.liberadoPor || 'Staff';
  $('#btn-prev').disabled = idx <= 0;
  $('#btn-next').disabled = idx >= pares.length - 1;
  $('#btn-prev').onclick = () => { RESULT_ID = pares[idx - 1].id; renderResultado(); };
  $('#btn-next').onclick = () => { RESULT_ID = pares[idx + 1].id; renderResultado(); };

  const marcasPre = [], marcasOf = [];
  for (const a of an.achados) {
    if (a.status === 'rejeitado') continue;
    const classe = a.tipo === 'omissao' ? 'om' : 'dv';
    if (a.trecho_pre) marcasPre.push({ trecho: a.trecho_pre, classe });
    if (a.trecho_oficial) marcasOf.push({ trecho: a.trecho_oficial, classe });
  }
  for (const g of an.greatCalls) if (g.trecho) marcasPre.push({ trecho: g.trecho, classe: 'gc' });
  $('#res-txt-pre').innerHTML = marcarTexto(pre.texto, marcasPre);
  $('#res-txt-oficial').innerHTML = marcarTexto(of.texto, marcasOf);

  const feed = [];
  const tipoNome = { omissao: 'Omissão', adicional: 'Achado adicional', divergencia: 'Divergência' };
  const macroNome = { percepcao: 'Percepção', interpretacao: 'Interpretação', comunicacao: 'Comunicação' };
  an.achados.forEach((a, i) => {
    const cls = a.tipo === 'omissao' ? '' : 'warn';
    const off = a.status === 'rejeitado' ? ' off' : '';
    const stTag = a.status !== 'pendente' ? `<span class="tag st-${a.status}">${a.status === 'discussao' ? 'p/ discussão' : a.status}</span>` : '';
    feed.push(`<div class="fcard ${cls}${off}">
      <div class="top"><strong>${esc(tipoNome[a.tipo])}: ${esc(a.titulo)}</strong>
        <span class="rp ${rpClasse(a.radpeer)}">${a.radpeer}</span>
        <span class="tag">${esc(macroNome[a.macro])} · ${esc(a.subtipo)}</span>${stTag}</div>
      <p class="why"><b>Por que importa:</b> ${esc(a.justificativa)}</p>
      <div class="actions">
        <button class="btn small confirm" data-st="confirmado" data-i="${i}">✓ Confirmar</button>
        <button class="btn small reject" data-st="rejeitado" data-i="${i}">Rejeitar</button>
        <button class="btn small warnb" data-st="discussao" data-i="${i}">Discordo do oficial</button>
      </div>
    </div>`);
  });
  if (!an.achados.length) feed.push(`<div class="fcard good"><div class="top"><strong>Concordância plena</strong><span class="rp g1">1</span></div><p class="why">Nenhuma discrepância identificada entre o pré-laudo e o laudo oficial.</p></div>`);
  for (const g of an.greatCalls) {
    feed.push(`<div class="fcard good"><div class="top"><strong>Great call: ${esc(g.titulo)}</strong><span class="tag">Acerto difícil</span></div><p class="why">${esc(g.descricao)}</p></div>`);
  }

  const alerta = await alertaRecorrencia(par, pre);
  if (alerta) feed.push(`<div class="alert"><b>Recorrência:</b> ${esc(alerta)}</div>`);

  if (an.sugestoes.length) {
    feed.push(`<div class="panel"><h4>Sugestões para a sua leitura</h4><ul>${an.sugestoes.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>`);
  }
  const rub = an.rubrica;
  if (rub && Object.values(rub).some(v => v)) {
    const nomes = { estrutura: 'Estrutura', terminologia: 'Terminologia', clareza: 'Clareza', concisao: 'Concisão' };
    feed.push(`<div class="panel"><h4>Rubrica de estilo</h4><div class="rubric">${Object.entries(nomes).map(([k, n]) =>
      rub[k] ? `<div class="rrow"><span>${n}</span><span class="bar"><i style="width:${rub[k] * 20}%"></i></span><span class="val">${rub[k]}/5</span></div>` : ''
    ).join('')}</div></div>`);
  }
  if (an.resumo) feed.push(`<div class="panel"><h4>Resumo</h4><p style="margin:0;font-size:12.5px;">${esc(an.resumo)}</p></div>`);
  $('#res-feed').innerHTML = feed.join('');

  $$('#res-feed [data-st]').forEach(b => b.addEventListener('click', async () => {
    const i = +b.dataset.i;
    const a = par.analise.achados[i];
    a.status = a.status === b.dataset.st ? 'pendente' : b.dataset.st;
    par.radpeerGeral = radpeerGeral(par.analise);
    await db.pares.put(par);
    renderResultado();
  }));
}

async function alertaRecorrencia(parAtual, preAtual) {
  const seg = segmentoDe(preAtual.titulo);
  const pares = await listaAnalisados();
  const corte = Date.now() - 60 * 24 * 3600 * 1000;
  const conta = {};
  for (const p of pares) {
    if (!p.analise || new Date(p.analisadoEm).getTime() < corte) continue;
    const pre = await db.laudos.get(p.preId);
    const s = segmentoDe(pre?.titulo || '');
    for (const a of p.analise.achados) {
      if (a.status === 'rejeitado') continue;
      const k = s + '|' + a.macro;
      conta[k] = (conta[k] || 0) + 1;
    }
  }
  for (const a of parAtual.analise.achados) {
    if (a.status === 'rejeitado') continue;
    const k = seg + '|' + a.macro;
    if (conta[k] >= 3) {
      const macroNome = { percepcao: 'de percepção', interpretacao: 'de interpretação', comunicacao: 'de comunicação' };
      return `${conta[k]}ª discrepância ${macroNome[a.macro]} em ${seg} nos últimos 60 dias — reveja o checklist deste segmento.`;
    }
  }
  return null;
}

/* ===================== segmentos / evolução ===================== */
function tabelaSegmentos() {
  return CFG.segmentos.split('\n').map(l => {
    const [nome, resto] = l.split(':');
    if (!nome || !resto) return null;
    return { nome: nome.trim(), palavras: resto.split(',').map(p => norm(p)).filter(Boolean) };
  }).filter(Boolean);
}
function segmentoDe(titulo) {
  const t = norm(titulo);
  for (const s of tabelaSegmentos()) {
    if (s.palavras.some(p => t.includes(p))) return s.nome;
  }
  return 'Outros';
}

async function renderEvolucao() {
  const pares = await listaAnalisados();
  const cont = $('#evo-conteudo');
  if (!pares.length) {
    cont.innerHTML = '<p class="hint">Nenhum exame analisado ainda — o painel aparece conforme você analisa pares.</p>';
    $('#evo-resumo').textContent = '';
    return;
  }
  const porId = new Map((await db.laudos.toArray()).map(l => [l.id, l]));
  const dados = pares.map(p => {
    const pre = porId.get(p.preId);
    const data = pre?.dataExame || p.analisadoEm;
    return { p, pre, data, seg: segmentoDe(pre?.titulo || ''), mes: (data || '').slice(0, 7) };
  });

  // concordância por mês
  const meses = {};
  for (const d of dados) {
    if (!meses[d.mes]) meses[d.mes] = { total: 0, conc: 0 };
    meses[d.mes].total++;
    if (d.p.radpeerGeral === '1') meses[d.mes].conc++;
  }
  const mesesOrd = Object.keys(meses).sort().slice(-8);
  const nomeMes = m => {
    const [a, mm] = m.split('-');
    return ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][+mm - 1] + '/' + a.slice(2);
  };
  const concHtml = mesesOrd.map(m => {
    const v = Math.round(100 * meses[m].conc / meses[m].total);
    return `<div class="rrow"><span>${nomeMes(m)} (${meses[m].total})</span><span class="bar"><i style="width:${v}%"></i></span><span class="val">${v}%</span></div>`;
  }).join('');

  // case-mix
  const segs = {};
  for (const d of dados) {
    if (!segs[d.seg]) segs[d.seg] = { n: 0, disc: 0 };
    segs[d.seg].n++;
    if (d.p.radpeerGeral !== '1') segs[d.seg].disc++;
  }
  const maxN = Math.max(...Object.values(segs).map(s => s.n));
  const segOrd = Object.entries(segs).sort((a, b) => b[1].n - a[1].n);
  const mixHtml = segOrd.map(([nome, s]) => {
    const taxa = Math.round(100 * s.disc / s.n);
    return `<div class="rrow"><span>${esc(nome)}</span><span class="bar"><i style="width:${Math.round(100 * s.n / maxN)}%"></i></span><span class="val">${s.n} · ${taxa}%</span></div>`;
  }).join('');
  const poucos = segOrd.filter(([, s]) => s.n < 10).map(([n, s]) => `${n} (${s.n})`);
  const poucosHtml = poucos.length ? `<p style="margin:9px 0 0; font-size:12px;"><span class="pill orphan">Amostra pequena</span> ${esc(poucos.join(', '))}: confiança estatística baixa — considere priorizar.</p>` : '';

  // padrões de erro
  const tipos = {};
  for (const d of dados) {
    for (const a of (d.p.analise?.achados || [])) {
      if (a.status === 'rejeitado') continue;
      const k = `${a.subtipo} em ${d.seg}`;
      if (!tipos[k]) tipos[k] = { n: 0, ultima: '' };
      tipos[k].n++;
      if (d.data > tipos[k].ultima) tipos[k].ultima = d.data;
    }
  }
  const corte45 = new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString();
  const recorrentes = Object.entries(tipos).filter(([, v]) => v.n >= 2 && v.ultima >= corte45).sort((a, b) => b[1].n - a[1].n).slice(0, 6);
  const superados = Object.entries(tipos).filter(([, v]) => v.n >= 2 && v.ultima < corte45).slice(0, 6);
  const recHtml = recorrentes.length ? recorrentes.map(([k, v]) => `<li><b>${esc(k)}</b> — ${v.n}× (última: ${fmtData(v.ultima)})</li>`).join('') : '<li class="hint">Nenhum padrão recorrente identificado.</li>';
  const supHtml = superados.length ? superados.map(([k, v]) => `<li><b>${esc(k)}</b> — ${v.n}× no passado, nenhum nos últimos 45 dias ✓</li>`).join('') : '<li class="hint">Continue analisando — padrões superados aparecem aqui.</li>';

  // estilo
  const rubMeses = {};
  for (const d of dados) {
    const r = d.p.analise?.rubrica;
    if (!r) continue;
    const vals = Object.values(r).filter(v => v);
    if (!vals.length) continue;
    if (!rubMeses[d.mes]) rubMeses[d.mes] = [];
    rubMeses[d.mes].push(vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  const rubHtml = Object.keys(rubMeses).sort().slice(-8).map(m => {
    const media = rubMeses[m].reduce((a, b) => a + b, 0) / rubMeses[m].length;
    return `<div class="rrow"><span>${nomeMes(m)}</span><span class="bar"><i style="width:${media * 20}%"></i></span><span class="val">${media.toFixed(1)}/5</span></div>`;
  }).join('');

  cont.innerHTML = `
    <div class="panel"><h4>Concordância plena (RadPeer 1)</h4><div class="rubric">${concHtml}</div></div>
    <div class="panel"><h4>Case-mix por segmento · nº exames · taxa de discrepância</h4><div class="rubric">${mixHtml}</div>${poucosHtml}</div>
    <div class="panel"><h4>Padrões recorrentes</h4><ul>${recHtml}</ul></div>
    <div class="panel"><h4>Superados</h4><ul>${supHtml}</ul></div>
    <div class="panel"><h4>Estilo de laudo (média da rubrica)</h4><div class="rubric">${rubHtml || '<p class="hint">Sem dados de rubrica ainda.</p>'}</div></div>`;
  $('#evo-resumo').textContent = `${pares.length} exame(s) analisados`;
}

/* ===================== checklist ===================== */
async function renderChecklist() {
  const pares = await listaAnalisados();
  const cont = $('#check-conteudo');
  const porId = new Map((await db.laudos.toArray()).map(l => [l.id, l]));
  const porSeg = {};
  for (const p of pares) {
    const pre = porId.get(p.preId);
    const seg = segmentoDe(pre?.titulo || '');
    for (const a of (p.analise?.achados || [])) {
      if (a.status === 'rejeitado') continue;
      if (!porSeg[seg]) porSeg[seg] = {};
      const k = a.titulo;
      if (!porSeg[seg][k]) porSeg[seg][k] = { n: 0, ultima: '', macro: a.macro, subtipo: a.subtipo };
      porSeg[seg][k].n++;
      const d = pre?.dataExame || p.analisadoEm;
      if (d > porSeg[seg][k].ultima) porSeg[seg][k].ultima = d;
    }
  }
  const blocos = [];
  for (const [seg, itens] of Object.entries(porSeg)) {
    const lista = Object.entries(itens).filter(([, v]) => v.n >= 1).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
    if (!lista.length) continue;
    blocos.push(`<div class="panel" style="max-width:620px; margin-bottom:14px;">
      <h4>${esc(seg)} — seu checklist pessoal</h4>
      <ul style="list-style:none; padding:0;">${lista.map(([t, v]) =>
        `<li>☐ <b>${esc(t)}</b> — <span class="hint">${v.n} ocorrência(s), última em ${fmtData(v.ultima)} · ${esc(v.subtipo)}</span></li>`).join('')}</ul>
    </div>`);
  }
  cont.innerHTML = blocos.length ? blocos.join('') : '<p class="hint">O checklist é gerado dos seus erros confirmados — analise pares primeiro.</p>';
}

/* ===================== config ===================== */
function renderConfig() {
  $('#cfg-modo').value = CFG.modo;
  $('#cfg-provider').value = CFG.provider;
  $('#cfg-key').value = CFG.apiKey;
  $('#cfg-model').value = CFG.model;
  $('#cfg-base').value = CFG.baseUrl;
  $('#cfg-anon').checked = !!CFG.anonimizar;
  $('#cfg-segmentos').value = CFG.segmentos;
  $('#sobre-pv').textContent = PROMPT_VERSION;
  atualizarCamposApi();
}
function atualizarCamposApi() {
  $('#cfg-api-campos').style.display = $('#cfg-modo').value === 'api' ? '' : 'none';
  const prov = $('#cfg-provider').value;
  $('#cfg-base-wrap').style.display = prov === 'compat' ? '' : 'none';
  const dicas = {
    gemini: 'Chave gratuita em aistudio.google.com → "Get API key". Só a chave basta — deixe Modelo vazio (usa gemini-2.5-flash). Funciona direto do navegador.',
    claude: 'Chave em console.anthropic.com (paga por uso). Só a chave basta — deixe Modelo vazio (usa claude-sonnet-5).',
    compat: 'Para modelos locais (Ollama, LM Studio) ou proxy próprio: informe a URL base (ex.: http://localhost:11434/v1). A API oficial da OpenAI NÃO aceita chamadas do navegador.'
  };
  $('#provider-dica').textContent = dicas[prov] || '';
  const ph = { gemini: 'ex.: gemini-2.5-flash (opcional)', claude: 'ex.: claude-sonnet-5 (opcional)', compat: 'ex.: llama3.1 (obrigatório p/ local)' };
  $('#cfg-model').placeholder = ph[prov] || '';
}

/* ===================== backup ===================== */
async function exportarBackup() {
  const dump = {
    versao: 1, exportadoEm: hoje(),
    laudos: await db.laudos.toArray(),
    pares: await db.pares.toArray(),
    config: (await db.config.toArray()).filter(c => c.key !== 'apiKey')
  };
  const zip = new JSZip();
  zip.file('radiopeer-backup.json', JSON.stringify(dump));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'radiopeer-backup-' + new Date().toISOString().slice(0, 10) + '.zip';
  a.click();
  URL.revokeObjectURL(a.href);
  $('#dados-msg').textContent = 'Backup exportado.';
}
async function importarBackup(file) {
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entry = zip.file('radiopeer-backup.json') || Object.values(zip.files).find(f => f.name.endsWith('.json'));
    if (!entry) throw new Error('ZIP sem arquivo de backup.');
    const dump = JSON.parse(await entry.async('string'));
    for (const l of dump.laudos || []) await db.laudos.put(l);
    for (const p of dump.pares || []) await db.pares.put(p);
    for (const c of dump.config || []) await db.config.put(c);
    await carregarConfig();
    await renderTudo();
    $('#dados-msg').textContent = `Backup importado: ${dump.laudos?.length || 0} laudos, ${dump.pares?.length || 0} pares.`;
    toast('Backup importado.');
  } catch (e) { $('#dados-msg').textContent = '⚠ ' + e.message; }
}
async function apagarTudo() {
  if (!confirm('Apagar TODOS os laudos, pares e análises deste navegador? Esta ação não pode ser desfeita.')) return;
  await db.laudos.clear();
  await db.pares.clear();
  await renderTudo();
  toast('Dados apagados.');
}

/* ===================== caso de exemplo ===================== */
const EXEMPLO_PRE = `HOSPITAL EXEMPLO - SETOR DE RADIOLOGIA
PACIENTE: JOSE DA SILVA (EXEMPLO)
ID: 483920    DATA: 15/08/2026
EXAME: RM DO JOELHO DIREITO

TÉCNICA: RM do joelho direito, protocolo padrão, sem contraste.

MENISCOS: ruptura horizontal do corno posterior do menisco medial. Menisco lateral preservado.

LIGAMENTOS: LCA e LCP íntegros. Ligamentos colaterais preservados.

CARTILAGEM: superfícies articulares preservadas.

OSSOS: tênue edema trabecular no planalto tibial lateral, compatível com contusão óssea.

DERRAME: pequeno derrame articular.

IMPRESSÃO:
1. Ruptura horizontal do corno posterior do menisco medial.
2. Contusão óssea no planalto tibial lateral.

Dr. Residente Exemplo`;
const EXEMPLO_OFICIAL = `HOSPITAL EXEMPLO - SETOR DE RADIOLOGIA
PACIENTE: JOSE DA SILVA (EXEMPLO)
ID: 483920    DATA: 15/08/2026
EXAME: RM DO JOELHO DIREITO

TÉCNICA: RM do joelho direito, protocolo padrão, sem contraste.

MENISCOS: degeneração mucoide grau II do corno posterior do menisco medial, sem traço de ruptura à superfície articular. Menisco lateral preservado.

LIGAMENTOS: LCA e LCP íntegros. Ligamentos colaterais preservados.

CARTILAGEM: condropatia patelar grau III, com fissuras na faceta lateral.

OSSOS: edema trabecular no planalto tibial lateral, compatível com contusão óssea.

DERRAME: pequeno derrame articular.

IMPRESSÃO:
1. Degeneração mucoide do corno posterior do menisco medial.
2. Condropatia patelar grau III.
3. Contusão óssea no planalto tibial lateral.

Dr. Staff Exemplo - CRM 00000`;

async function carregarExemplo() {
  const jaTem = await db.laudos.where('hash').equals('exemplo-pre').first();
  if (jaTem) { toast('O caso de exemplo já foi carregado.'); show('v-pares'); return; }
  const mkLaudo = (tipo, texto, hash, liberou) => {
    const meta = extrairMeta(texto);
    const l = { id: uuid(), tipo, hash, fileName: 'exemplo_' + tipo + '.txt', texto, nome: meta.nome, pacienteId: meta.pacienteId, titulo: meta.titulo, dataExame: meta.dataExame, liberadoPor: liberou, chave: '', importadoEm: hoje() };
    l.chave = chaveLaudo(l);
    return l;
  };
  const pre = mkLaudo('pre', EXEMPLO_PRE, 'exemplo-pre', 'Dr. Residente Exemplo');
  const of = mkLaudo('oficial', EXEMPLO_OFICIAL, 'exemplo-oficial', 'Dr. Staff Exemplo');
  await db.laudos.bulkAdd([pre, of]);
  const par = { id: uuid(), preId: pre.id, oficialId: of.id, status: 'analisado', criadoEm: hoje(), analisadoEm: hoje(), promptVersion: PROMPT_VERSION };
  par.analise = {
    achados: [
      { titulo: 'Condropatia patelar grau III', tipo: 'omissao', macro: 'percepcao', subtipo: 'under-reading', radpeer: '3b', justificativa: 'Condropatia de alto grau muda a conduta ortopédica e é achado esperado na avaliação sistemática da cartilagem. Dica: inclua a articulação patelofemoral na varredura mesmo quando a queixa é meniscal.', trecho_pre: '', trecho_oficial: 'condropatia patelar grau III, com fissuras na faceta lateral', status: 'pendente' },
      { titulo: 'Ruptura × degeneração mucoide do menisco medial', tipo: 'divergencia', macro: 'interpretacao', subtipo: 'raciocinio incorreto', radpeer: '2a', justificativa: 'Degeneração mucoide grau II pode simular ruptura horizontal; o critério distintivo é o contato do sinal com a superfície articular. Provavelmente sem impacto clínico imediato.', trecho_pre: 'ruptura horizontal do corno posterior do menisco medial', trecho_oficial: 'degeneração mucoide grau II do corno posterior do menisco medial, sem traço de ruptura à superfície articular', status: 'pendente' }
    ],
    greatCalls: [
      { titulo: 'Contusão óssea sutil no planalto tibial', descricao: 'Edema trabecular tênue identificado e corretamente caracterizado no pré-laudo.', trecho: 'tênue edema trabecular no planalto tibial lateral, compatível com contusão óssea' }
    ],
    rubrica: { estrutura: 4, terminologia: 4, clareza: 3, concisao: 4 },
    sugestoes: ['Adotar segunda varredura da cartilagem (patela, tróclea, côndilos) após concluir a avaliação principal.', 'Revisar o critério ruptura × degeneração mucoide: sinal tocando a superfície articular.', 'Na impressão, use "compatível com" quando o critério for limítrofe.'],
    resumo: 'Bom laudo estrutural com um erro de percepção importante (cartilagem patelar) e uma divergência interpretativa de baixo impacto.'
  };
  par.radpeerGeral = radpeerGeral(par.analise);
  await db.pares.add(par);
  await renderTudo();
  RESULT_ID = par.id;
  show('v-result');
  toast('Caso de exemplo carregado — este é um resultado de demonstração (dados fictícios).');
}

/* ===================== eventos ===================== */
function ligarDropzone(dropId, inputId, tipo) {
  const drop = $(dropId), input = $(inputId);
  input.addEventListener('change', () => { if (input.files.length) ingerirArquivos(input.files, tipo); input.value = ''; });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('dragover');
    if (e.dataTransfer.files.length) ingerirArquivos(e.dataTransfer.files, tipo);
  });
}

async function renderTudo() {
  await renderEnviar();
  const ativa = $('.view.active')?.id;
  if (ativa === 'v-pares') await renderPares();
  if (ativa === 'v-analise') await renderAnalise();
  if (ativa === 'v-result') await renderResultado();
  if (ativa === 'v-evolucao') await renderEvolucao();
  if (ativa === 'v-checklist') await renderChecklist();
}

async function init() {
  await carregarConfig();
  $$('.rail button').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
  ligarDropzone('#drop-pre', '#file-pre', 'pre');
  ligarDropzone('#drop-oficial', '#file-oficial', 'oficial');
  $('#btn-ir-analise').addEventListener('click', () => show('v-analise'));
  $('#btn-sample').addEventListener('click', carregarExemplo);
  $('#btn-analisar-todos').addEventListener('click', () => show('v-analise'));
  $('#busca-pares').addEventListener('input', renderPares);
  $('#filtro-pares').addEventListener('change', renderPares);
  $('#tbody-pares').addEventListener('click', e => {
    const a = e.target.closest('a.go');
    if (!a) return;
    if (a.dataset.ver) { RESULT_ID = a.dataset.ver; show('v-result'); }
    if (a.dataset.editar) abrirEditar(a.dataset.editar);
    if (a.dataset.parear) abrirParear(a.dataset.parear);
    if (a.dataset.desfazer) desfazerPar(a.dataset.desfazer);
    if (a.dataset.excluir) { if (confirm('Excluir este laudo?')) db.laudos.delete(a.dataset.excluir).then(renderTudo); }
  });
  $('#btn-copiar-prompt').addEventListener('click', copiarPrompt);
  $('#btn-validar').addEventListener('click', validarResposta);
  $('#btn-rodar-api').addEventListener('click', rodarFilaAPI);
  $('#btn-pdf').addEventListener('click', () => window.print());

  // config
  $('#cfg-modo').addEventListener('change', async e => { await salvarConfig({ modo: e.target.value }); atualizarCamposApi(); });
  $('#cfg-provider').addEventListener('change', async e => { await salvarConfig({ provider: e.target.value }); atualizarCamposApi(); });
  $('#cfg-key').addEventListener('change', e => salvarConfig({ apiKey: e.target.value.trim() }));
  $('#cfg-model').addEventListener('change', e => salvarConfig({ model: e.target.value.trim() }));
  $('#cfg-base').addEventListener('change', e => salvarConfig({ baseUrl: e.target.value.trim() }));
  $('#cfg-anon').addEventListener('change', e => salvarConfig({ anonimizar: e.target.checked }));
  $('#btn-salvar-seg').addEventListener('click', async () => { await salvarConfig({ segmentos: $('#cfg-segmentos').value }); toast('Segmentos salvos.'); });
  $('#btn-testar-api').addEventListener('click', async () => {
    $('#teste-api-msg').textContent = 'testando…';
    try {
      const r = await chamarIA('Responda apenas com a palavra OK.');
      $('#teste-api-msg').textContent = /ok/i.test(r) ? '✓ Conexão funcionando.' : '✓ Respondeu: ' + r.slice(0, 60);
    } catch (e) { $('#teste-api-msg').textContent = '⚠ ' + e.message; }
  });
  $('#btn-backup').addEventListener('click', exportarBackup);
  $('#file-import').addEventListener('change', e => { if (e.target.files[0]) importarBackup(e.target.files[0]); e.target.value = ''; });
  $('#btn-apagar').addEventListener('click', apagarTudo);

  await renderTudo();
}

init();

function irParaResultado() { show('v-result'); }
