# RADIOPEER 🩻

Ferramenta de aprendizado para residentes de radiologia: compara o **pré-laudo do residente** com o **laudo oficial** do staff, classifica as discrepâncias pela escala **RadPeer (ACR 2016)** com taxonomia de Kim–Mansfield, registra *great calls* e acompanha a evolução ao longo do tempo.

**Acesse:** https://hercules-riani.github.io/radiopeer/

## Como funciona

1. **Enviar** — arraste seus pré-laudos e os laudos oficiais (PDF, Word, TXT ou ZIP). O programa lê os arquivos e pareia automaticamente por paciente + título do exame.
2. **Analisar** — modo assistido: copie o prompt gerado, cole no seu ChatGPT/Claude/Gemini, e cole a resposta de volta. (Opcional: configure uma chave de API para automatizar.)
3. **Resultado** — laudos lado a lado com discrepâncias destacadas, grau RadPeer por achado, great calls, sugestões de leitura e rubrica de estilo. Você confirma, rejeita ou marca "discordo do oficial" em cada achado.
4. **Evolução / Checklist** — concordância no tempo, case-mix por segmento, padrões recorrentes e checklist pessoal gerado dos seus erros.

## Privacidade

Todo o processamento acontece **no seu navegador** — nenhum laudo é enviado a servidor algum. Os dados ficam no IndexedDB do navegador; use o backup em ZIP (Configurações) para não perdê-los. O texto só sai da sua máquina se você colá-lo no seu chat de IA ou usar uma chave de API — há um toggle de anonimização para remover nome/ID do paciente antes disso.

## Desenvolvimento

Site estático puro (HTML/CSS/JS) — sem build, sem backend. Bibliotecas via CDN: Dexie (IndexedDB), JSZip, pdf.js, mammoth.

---
Projeto pessoal de aprendizado — não substitui a revisão formal do preceptor nem sistemas oficiais de peer review.
