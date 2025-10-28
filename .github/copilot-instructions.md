## Purpose

Short, actionable guidance for AI coding agents working on this repository (a TypeScript Telegram bot).

## Big picture

- Single-process TypeScript Telegram bot wired in `src/main.ts`.
- `src/core` contains runtime primitives: `bot.ts` (Telegraf instance) and `config.ts` (loads `BOT_TOKEN` from `.env`).
- `src/modules/*` follow a controller/service pattern: `.service.ts` does API calls/logic, `.controller.ts` handles Telegraf `Context` and user interactions.
- Shared types live in `src/common/interfaces.ts` — prefer using these when adding or changing typed data.
- State is in-memory: `userState` Map in `src/main.ts`. There is no DB or persistence by default.

Key files to inspect first: `src/main.ts`, `src/core/bot.ts`, `src/core/config.ts`, `src/common/interfaces.ts`, and any `src/modules/<name>/*` pair.

## How to run (developer workflows)

- Install deps: run `npm install` in the repository root.
- Development (hot-reload): `npm run start:dev` — this project uses `nodemon src/main.ts`.
  - If your environment doesn't auto-run TypeScript files, run `npx ts-node src/main.ts` or adjust `nodemon.json` to use `ts-node`.
- Build for production: `npm run build` -> `tsc` -> produced code expected at `dist/main.js`.
- Start production build: `npm run start` (runs `node dist/main.js`).

Example (PowerShell):

```
npm install
npm run start:dev    # dev mode
npm run build && npm run start   # build + run
```

## Environment & external integrations

- The bot reads `BOT_TOKEN` from environment via `src/core/config.ts`. If missing, the app throws on startup.
- Other external APIs require credentials (examples visible in code): `BINANCE_API_KEY`, `BINANCE_API_SECRET`. Search for `process.env.` to find all required variables.
- Key runtime libraries: `telegraf` (Telegram), `@binance/derivatives-trading-portfolio-margin`, `axios`, `starknet`, `node-cron`.

Be mindful of API rate limits and secrets — do not commit `.env` to source control. Prefer adding a `.env.example` documenting keys.

## Project-specific conventions and patterns

- Controller/Service pattern per module:
  - `<module>.service.ts` = API calls, data aggregation, pure logic.
  - `<module>.controller.ts` = interacts with Telegraf `Context`, formats replies, uses services.
  - Example: `src/modules/binance/binance.service.ts` and `src/modules/binance/binance.controller.ts`.
- Manual wiring: `src/main.ts` instantiates services and controllers directly (no DI container). To add a feature:
  1. Create service and controller files in `src/modules/<yourModule>/`.
  2. Instantiate service and controller in `src/main.ts` and add routing to the message handler or menu.
  3. If you need to keep per-user flow, use the existing `userState: Map<number,string>` (passed into controllers where required).
- Keyboard/menu: `mainMenuKeyboard` (in `src/main.ts`) defines the menu layout. Add new menu buttons both to the keyboard and to the `mainMenuCommands` switch so the router can dispatch them.
- Message parsing: the app uses `bot.on(message('text'), ...)` to route text messages and `ctx.reply(...)` with MarkdownV2 escaping when needed.

## Adding a new module (quick recipe)

1. `src/modules/<name>/<name>.service.ts` — implement API calls and data functions; export a class.
2. `src/modules/<name>/<name>.controller.ts` — accept `(service, userState)` in constructor; implement handler methods that accept `ctx` and reply.
3. Wire in `src/main.ts`: instantiate service and controller, add menu button to `mainMenuKeyboard` and add entry to `mainMenuCommands` switch that calls your controller method.
4. Add any required env vars to `.env` and document them in `README.md` or a `.env.example`.

## Common pitfalls & notes for automation

- The app stores user state in memory — restarting the bot clears it. Automation that depends on persistence must add a storage layer.
- Error handling in services often logs and rethrows. For automated fixes, prefer returning structured errors or use the helper pattern shown in the `binance.service.ts` file (see the getErrorMessage helper).
- Tests: none included — CI and unit tests are not present. If adding tests, prefer small unit tests for services that mock HTTP responses and integration tests for controllers using a Telegraf test harness.

## Useful code references (examples to cite in PRs)

- wiring & router: `src/main.ts`
- bot instance & lifecycle: `src/core/bot.ts` and `src/core/config.ts`
- shared types: `src/common/interfaces.ts`
- example module: `src/modules/binance/*` (service + controller pattern)

---

If anything above is unclear or you want examples for adding a concrete feature (new module, new env var, or persistent state), tell me which area and I will expand the instructions or add a short example patch.
