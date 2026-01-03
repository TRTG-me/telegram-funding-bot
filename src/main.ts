import { Markup } from 'telegraf';
import { bot } from './core/bot';
import { message } from 'telegraf/filters';

// --- Services ---
import { BinanceService } from './modules/binance/binance.service';
import { HyperliquidService } from './modules/hyperliquid/hyperliquid.service';
import { ParadexService } from './modules/paradex/paradex.service';
import { LighterService } from './modules/lighter/lighter.service';
import { ExtendedService } from './modules/extended/extended.service';

// --- Ticker Services ---
import { BinanceTickerService } from './modules/binance/websocket/binance.ticker.service';
import { HyperliquidTickerService } from './modules/hyperliquid/websocket/hyperliquid.ticker.service';
import { ParadexTickerService } from './modules/paradex/websocket/paradex.ticker.service';
import { ExtendedTickerService } from './modules/extended/websocket/extended.ticker.service';
import { LighterTickerService } from './modules/lighter/websocket/lighter.ticker.service';

// --- Aggregator Services ---
import { SummaryService } from './modules/summary/summary.service';
import { TotalPositionsService } from './modules/totalPositions/totalPositions.service';
import { TotalFundingsService } from './modules/totalFundings/totalFundings.service';
import { BpService } from './modules/bp/bp.service';
import { AutoTradeService } from './modules/auto_trade/auto_trade.service';
import { AutoCloseService } from './modules/auto_close/auto_close.service';
import { PayBackService } from './modules/payback/payback.service';
import { FundingApiService } from './modules/funding_api/funding_api.service';
import { UserService } from './modules/users/users.service';
import { SettingsService } from './modules/settings/settings.service';

// --- Controllers ---
import { SummaryController } from './modules/summary/summary.controller';
import { TotalPositionsController } from './modules/totalPositions/totalPositions.controller';
import { TotalFundingsController } from './modules/totalFundings/totalFundings.controller';
import { BpController } from './modules/bp/bp.controller';
import { AutoTradeController } from './modules/auto_trade/auto_trade.controller';
import { ExtendedTradeController } from './modules/extended/extended.trade.controller';
import { LighterController } from './modules/lighter/lighter.controller';
import { AutoCloseController } from './modules/auto_close/auto_close.controller';
import { PayBackController } from './modules/payback/payback.controller';
import { FundingApiController } from './modules/funding_api/funding_api.controller';
import { UsersController } from './modules/users/users.controller';
import { SettingsController } from './modules/settings/settings.controller';

// ============================================================
// ГЛОБАЛЬНАЯ ЗАЩИТА (ЧТОБЫ НЕ ПАДАЛО ПРИ ОШИБКАХ СЕТИ)
// ============================================================

// 1. Необработанные исключения (например, axios timeout вне try-catch)
process.on('uncaughtException', (err) => {
    console.error('🔥 UNCAUGHT EXCEPTION:', err);
    // Если ошибка связана с сетью/сокетами, игнорируем и живем дальше
    if (err.message.includes('ETIMEDOUT') ||
        err.message.includes('socket hang up') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('getaddrinfo') ||
        err.message.includes('FetchError')) {
        console.log('⚠️ Network glitch detected. Process will continue.');
        return;
    }
    // В других случаях PM2 перезапустит процесс, но для трейд-бота 
    // мы стараемся выжить любой ценой, чтобы сохранить стейт.
});

// 2. Необработанные промисы (часто бывают при дисконнектах базы или API)
process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 UNHANDLED REJECTION:', reason);
    // Просто логируем, не роняем процесс
});

// ============================================================

// --- Keyboards ---
const mainMenuKeyboard = Markup.keyboard([
    ['Trade-BOT', 'Fundings']
]).resize();

const tradeBotKeyboard = Markup.keyboard([
    ['Плечи', 'Позиции', 'Фандинги', 'bp', 'OPEN POS'],
    ['Окупаемость', 'Ручная проверка', 'Автоматическая проверка'],
    ['Настройки', '🔙 Назад в меню']
]).resize();

const userState = new Map<number, string>();

async function start() {
    // ============================================================
    // 1. ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ (СЛОЙ ДАННЫХ)
    // ============================================================

    // Базовые сервисы бизнес-логики (БД)
    const userService = new UserService();

    // Базовые сервисы бирж (с внедрением UserService)
    const binanceService = new BinanceService(userService);
    const hyperliquidService = new HyperliquidService(userService);
    const paradexService = new ParadexService(userService);
    const lighterService = new LighterService(userService);
    const extendedService = new ExtendedService(userService);

    // Веб-сокет тикеры
    const binanceTickerService = new BinanceTickerService();
    const hyperliquidTickerService = new HyperliquidTickerService();
    const paradexTickerService = new ParadexTickerService();
    const extendedTickerService = new ExtendedTickerService();
    const lighterTickerService = new LighterTickerService();

    // Сервисы бизнес-логики
    const settingsService = new SettingsService();

    const summaryService = new SummaryService(
        binanceService, hyperliquidService, paradexService, lighterService, extendedService, settingsService
    );

    const totalPositionsService = new TotalPositionsService(
        binanceService, hyperliquidService, paradexService, lighterService, extendedService
    );

    const totalFundingsService = new TotalFundingsService(
        totalPositionsService
    );

    const bpService = new BpService(
        lighterService
    );

    const autoTradeService = new AutoTradeService(
        binanceService,
        hyperliquidService,
        paradexService,
        extendedService,
        lighterService
    );

    const autoCloseService = new AutoCloseService(
        binanceService,
        hyperliquidService,
        paradexService,
        lighterService,
        extendedService,
        settingsService
    );

    const fundingApiService = new FundingApiService();

    const payBackService = new PayBackService(
        lighterService,
        fundingApiService
    );

    // ============================================================
    // 2. ИНИЦИАЛИЗАЦИЯ КОНТРОЛЛЕРОВ (СЛОЙ ВЗАИМОДЕЙСТВИЯ)
    // ============================================================

    const summaryController = new SummaryController(summaryService);
    const totalPositionsController = new TotalPositionsController(totalPositionsService);
    const totalFundingsController = new TotalFundingsController(totalFundingsService);
    const bpController = new BpController(bpService);
    const autoTradeController = new AutoTradeController(autoTradeService);
    const extendedTradeController = new ExtendedTradeController(extendedService);
    const lighterController = new LighterController(lighterService);
    const autoCloseController = new AutoCloseController(autoCloseService);
    const payBackController = new PayBackController(payBackService);
    const fundingApiController = new FundingApiController(fundingApiService);
    const usersController = new UsersController(userService);
    const settingsController = new SettingsController(settingsService, userState);

    // ============================================================
    // 3. ОБРАБОТЧИКИ TELEGRAM
    // ============================================================

    // Перехват ошибок Telegraf (чтобы бот не падал при сбоях отправки сообщений)
    bot.catch((err: any, ctx: any) => {
        console.error(`❌ Telegraf Error for ${ctx.updateType}:`, err.message);
    });

    bot.start((ctx) => {
        if (ctx.from) {
            userState.delete(ctx.from.id);
        }
        ctx.reply('Привет! Используйте меню внизу.', mainMenuKeyboard);
    });

    // Обработка кнопок (Inline)
    bot.on('callback_query', (ctx) => {
        const data = (ctx.callbackQuery as any).data;

        if (data && data.startsWith('bp_')) {
            return bpController.handleCallbackQuery(ctx);
        }

        if (data && (data.startsWith('at_') || data === 'stop_autotrade')) {
            return autoTradeController.handleCallback(ctx);
        }

        if (data && data.startsWith('settings_')) {
            return settingsController.handleCallback(ctx);
        }

        if (data && data.startsWith('payback_')) {
            return payBackController.handleCallbackQuery(ctx);
        }

        if (data && data.startsWith('fapi_')) {
            return fundingApiController.handleCallbackQuery(ctx);
        }
    });

    // Обработка текста
    bot.on(message('text'), async (ctx) => { // <-- ASYNC
        const userId = ctx.from?.id;
        if (!userId) return;
        const text = ctx.message.text;

        if (text === '🔙 Назад' || text === '🔙 Назад в меню') {
            return ctx.reply('Меню:', mainMenuKeyboard);
        }

        // --- USER GUARD: ЗАЩИТА ---
        // Пропускаем /start и /admin, чтобы юзер мог добавиться или зарегистрироваться
        if (text !== '/start' && !text.startsWith('/admin')) {
            const hasAccess = await userService.hasAccess(userId);
            if (!hasAccess) {
                return ctx.reply('⛔️ <b>Ошибка доступа</b>\nВашего ID нет в базе данных.\nОбратитесь к администратору.', { parse_mode: 'HTML' });
            }
        }
        const mainMenuCommands = [
            'Trade-BOT', 'Fundings'
        ];

        const tradeBotCommands = [
            'Плечи', 'Позиции', 'Фандинги', 'bp', 'OPEN POS',
            'Окупаемость', 'Ручная проверка', 'Автоматическая проверка', 'Настройки'
        ];

        const fundingApiCommands = [
            '🔍 Фандинг монеты', '🏆 Лучшие монеты', '🔄 Обновить список монет', '🚀 Обновить БД'
        ];

        if (mainMenuCommands.includes(text)) {
            userState.delete(userId);
            if (text === 'Trade-BOT') {
                return ctx.reply('Меню торгового бота:', tradeBotKeyboard);
            }
            if (text === 'Fundings') {
                return fundingApiController.handleFundingMenu(ctx);
            }
        }

        if (tradeBotCommands.includes(text)) {
            userState.delete(userId);

            switch (text) {
                case 'Плечи':
                    return summaryController.sendSummaryTable(ctx);
                case 'Позиции':
                    return totalPositionsController.displayAggregatedPositions(ctx);
                case 'Фандинги':
                    return totalFundingsController.displayHistoricalFunding(ctx);
                case 'bp':
                    return bpController.handleBpCommand(ctx);
                case 'OPEN POS':
                    return autoTradeController.handleOpenPosCommand(ctx);
                case 'Окупаемость':
                    return payBackController.handlePayBackCommand(ctx);
                case 'Ручная проверка':
                    return autoCloseController.handleManualCheck(ctx);
                case 'Автоматическая проверка':
                    return autoCloseController.handleToggleMonitor(ctx);
                case 'Настройки':
                    return settingsController.onSettingsCommand(ctx);
            }
            return;
        }

        if (fundingApiCommands.includes(text)) {
            userState.delete(userId);
            switch (text) {
                case '🔍 Фандинг монеты':
                    return fundingApiController.handleCoinAnalysisStart(ctx);
                case '🏆 Лучшие монеты':
                    return fundingApiController.handleBestOpportunities(ctx);
                case '🔄 Обновить список монет':
                    return fundingApiController.handleSyncCoins(ctx);
                case '🚀 Обновить БД':
                    return fundingApiController.handleSyncFull(ctx);
            }
            return;
        }

        // --- ЛОГИКА 2: ВВОД ДАННЫХ ДЛЯ СЕРВИСОВ ---

        // AutoTrade Flow
        if (autoTradeController.isUserInFlow(userId)) {
            return autoTradeController.handleInput(ctx);
        }

        // BP Flow
        if (bpController.isUserInBpFlow(userId)) {
            return bpController.handleCoinInput(ctx);
        }

        // Payback Flow
        if (payBackController.isUserInFlow(userId)) {
            return payBackController.handleTextInput(ctx);
        }

        // Funding API Flow
        if (fundingApiController.isUserInFlow(userId)) {
            return fundingApiController.handleTextInput(ctx);
        }

        // --- ЛОГИКА 3: ДРУГИЕ СОСТОЯНИЯ ---
        const currentState = userState.get(userId);

        if (currentState === 'awaiting_settings_json') {
            return settingsController.onSettingsJsonReceived(ctx);
        }
        else {
            ctx.reply('Неизвестная команда. Пожалуйста, используйте кнопки внизу.', mainMenuKeyboard);
        }
    });

    // Оборачиваем launch в try-catch для защиты при старте
    try {
        await bot.launch();
        console.log('✅ Бот успешно запущен со всеми модулями!');
    } catch (err: any) {
        console.error('❌ Ошибка запуска бота (проверьте интернет/токен):', err.message);
        // Не выходим, PM2 или retry логика может помочь, но здесь просто лог
    }

    const gracefulShutdown = (signal: string) => {
        console.log(`\n[Graceful Shutdown] Получен сигнал ${signal}. Завершение...`);
        autoCloseService.stopAll();
        payBackService.stopAll();
        bot.stop(signal);
        console.log('[Graceful Shutdown] Готово.');
        process.exit(0);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

start();