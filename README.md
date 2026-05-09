# Golaço API (Vercel)

Backend serverless que substitui o Cloudflare Worker do projeto. Mantém **as mesmas rotas** que o `app.min.js` já consome — só muda a URL base.

## Por que migrar?

O Cloudflare Worker estava sendo bloqueado ao chamar `webws.365scores.com` e `api.sofascore.com` porque ambos os domínios ficam atrás de Cloudflare com Bot Management ativo. Quando um Worker faz `fetch()` para outro domínio Cloudflare, o tráfego é roteado internamente como subrequest "cross-zone" e a ponta destino enxerga a origem como tráfego de Worker — fácil de bloquear.

A Vercel roda Functions em AWS Lambda, IPs comuns de datacenter, fora da rede da Cloudflare. Resolve o problema na origem.

## Estrutura

```
golaco-api/
├── api/
│   └── [...path].js     ← roteador catch-all com toda a lógica
├── package.json
├── vercel.json          ← região gru1 (São Paulo), maxDuration 10s
└── README.md
```

## Deploy em 5 minutos

### 1. Criar repositório no GitHub

```bash
cd golaco-api
git init
git add .
git commit -m "initial: golaco api on vercel"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/golaco-api.git
git push -u origin main
```

### 2. Importar na Vercel

1. Acesse <https://vercel.com/new>
2. Conecte sua conta GitHub e importe o repo `golaco-api`
3. Em **Framework Preset** selecione **Other**
4. Não precisa configurar Build Command nem Output Directory
5. (Opcional) Em **Environment Variables** adicione:
   - `ALLOWED_ORIGIN` = `https://seu-frontend.pages.dev` (restringe CORS; deixe sem setar para liberar `*`)
6. Clique **Deploy**

A URL final será algo como `https://golaco-api.vercel.app`.

### 3. Testar antes de mexer no frontend

```bash
# Health
curl https://golaco-api.vercel.app/api/

# Debug — mostra o que a 365scores está respondendo de fato
curl https://golaco-api.vercel.app/api/_debug

# Live (deve voltar { "games": [...] })
curl https://golaco-api.vercel.app/api/live
```

Se `/api/_debug` voltar `status: 200` e `bodyLooksHtml: false`, está funcionando.
Se voltar `bodyLooksHtml: true`, é challenge — mas não deve acontecer vindo de IPs AWS.

### 4. Apontar o frontend para a nova URL

No `app.min.js`, troque a constante `$`:

**Antes:**
```js
const $ = "https://golaco-worker.davi-caraujo32.workers.dev"
```

**Depois:**
```js
const $ = "https://golaco-api.vercel.app"
```

Como o arquivo é minificado, faça um find-and-replace simples (Ctrl+H no editor, ou `sed`):

```bash
sed -i 's|https://golaco-worker.davi-caraujo32.workers.dev|https://golaco-api.vercel.app|g' app.min.js
```

Faça o redeploy do frontend (Cloudflare Pages) e pronto.

## Endpoints

Todos retornam JSON com headers CORS liberados.

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/live` | Jogos do dia (inclui ao vivo). Cache 10s. |
| GET | `/api/results?from=DD/MM/YYYY&to=DD/MM/YYYY` | Resultados. Cache 1h se range; 2min sem. |
| GET | `/api/upcoming?from=&to=` | Próximos jogos. Cache 5min. |
| GET | `/api/stats/:gameId` | Stats de um jogo + competidores. Cache 15s. |
| GET | `/api/standings?comp=113\|116\|5518` | Tabela. Cache 10min. |
| GET | `/api/sf/live` | Sofascore — todos os jogos ao vivo. |
| GET | `/api/sf/scheduled?date=YYYY-MM-DD` | Sofascore — agenda do dia. |
| GET | `/api/sf/event/:id` | Sofascore — pacote (event+stats+momentum+odds+h2h). |
| GET | `/api/sf/event/:id/:sub` | Sofascore — sub-recurso (`statistics`, `momentum`, etc). |
| GET | `/api/_debug?u=<url>` | Diagnóstico cru: status, headers e início do body do upstream. |
| GET | `/api/` ou `/api/health` | Health check + lista de endpoints. |

## Diferenças vs. Worker antigo

- **Erros não são mais mascarados como `200 + array vazio`.** Falha no upstream agora retorna `502` com `{ error, status, statusText, bodyHint }`. O frontend não trata isso ainda, mas o DevTools/Network passa a mostrar a falha real (você não fica mais cego).
- **Header `User-Agent` é Chrome real**, com `Origin`, `Sec-Fetch-*` e `Accept-Language`.
- **Cache em memória local** (Map com TTL). Funciona dentro da mesma instância quente da função. Não é distribuído — para um hobby project, suficiente. Se um dia precisar de cache global, plugue Redis (Upstash, gratuito).
- **Endpoint `/api/_debug`** novo, para diagnóstico futuro sem ter que mexer em código.
- **Região `gru1`** (São Paulo) configurada no `vercel.json`. Hobby plan permite uma região, e essa é a mais perto dos seus usuários e da 365scores.

## Custo

Plano Hobby da Vercel é gratuito até **100 GB-Hours de execução** e **1 milhão de invocações/mês**. Para um app de stats consultando algumas centenas de vezes por dia, sobra muito.

## Manutenção

- Se a 365scores um dia mudar a estrutura do JSON ou um endpoint, o `/api/_debug` é a primeira parada para entender o que voltou.
- Se Sofascore começar a bloquear também (improvável, mas a internet é hostil), considere uma fonte paga: API-Football (RapidAPI) tem Brasileirão completo a partir de US$10/mês.
