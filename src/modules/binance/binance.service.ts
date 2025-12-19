import axios from 'axios';
import {
    DerivativesTradingPortfolioMargin,
    DERIVATIVES_TRADING_PORTFOLIO_MARGIN_REST_API_PROD_URL,
} from '@binance/derivatives-trading-portfolio-margin';

import {
    DerivativesTradingUsdsFutures,
    DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL,
} from '@binance/derivatives-trading-usds-futures';

import { IExchangeData, IDetailedPosition, IAccountInfoBin, IPositionInfoBin } from '../../common/interfaces';

export class BinanceService {
    // Клиент может быть одного из двух типов в зависимости от режима
    private client: DerivativesTradingPortfolioMargin | DerivativesTradingUsdsFutures;
    private readonly isTestnet: boolean;

    private timeOffset = 0;
    private lastRttMs = 0;

    constructor() {
        // 1. Определение режима из .env
        this.isTestnet = process.env.TESTNET === 'true';

        let apiKey: string;
        let apiSecret: string;
        let basePath: string;

        // 2. Настройка ключей и URL
        if (this.isTestnet) {
            console.log('🟡 [Binance] Initializing in TESTNET mode');
            apiKey = process.env.BINANCE_API_KEY_TEST || '';
            apiSecret = process.env.BINANCE_API_SECRET_TEST || '';
            basePath = DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL; // https://testnet.binancefuture.com
        } else {
            console.log('🟢 [Binance] Initializing in MAINNET mode');
            apiKey = process.env.BINANCE_API_KEY || '';
            apiSecret = process.env.BINANCE_API_SECRET || '';
            // Для продакшна используем Portfolio Margin URL (как было у вас раньше)
            basePath = DERIVATIVES_TRADING_PORTFOLIO_MARGIN_REST_API_PROD_URL;
        }

        if (!apiKey || !apiSecret) {
            throw new Error(`Binance API Key/Secret missing for ${this.isTestnet ? 'TESTNET' : 'MAINNET'}`);
        }

        const config = {
            apiKey,
            apiSecret,
            basePath,
            recvWindow: 60000,
            timeout: 30000
        };

        // 3. Инициализация нужного клиента SDK
        if (this.isTestnet) {
            // Для теста - обычные фьючерсы
            this.client = new DerivativesTradingUsdsFutures({ configurationRestAPI: config });
        } else {
            // Для прода - портфельная маржа
            this.client = new DerivativesTradingPortfolioMargin({ configurationRestAPI: config });
        }

        // Синхронизация времени
        this.syncTime().catch(() => { });
        setInterval(() => this.syncTime().catch(() => { }), 60_000);
    }

    private async syncTime() {
        const url = this.isTestnet
            ? 'https://testnet.binancefuture.com/fapi/v1/time'
            : 'https://fapi.binance.com/fapi/v1/time';

        let attempts = 0;
        const maxAttempts = 10; // Пытаемся 10 раз

        while (attempts < maxAttempts) {
            try {
                const start = Date.now(); // Замеряем время конкретного запроса
                const r = await axios.get(url, { timeout: 5000 }); // Таймаут 5 сек, чтобы не висеть вечно
                const end = Date.now();

                const serverTime = r.data.serverTime as number;
                this.lastRttMs = end - start;

                this.timeOffset = serverTime - end;

                // console.log(`[Binance] Time synced. Offset: ${this.timeOffset}ms`);
                return; // УСПЕХ: выходим из функции

            } catch (e: any) {
                attempts++;
                console.warn(`[Binance] Time sync failed (Attempt ${attempts}/${maxAttempts}): ${e.message}`);

                if (attempts === maxAttempts) {
                    console.error('[Binance] CRITICAL: Time sync failed after all attempts. Trading might fail.');
                    this.timeOffset = 0; // Сбрасываем в 0, надеемся на точность системных часов
                } else {
                    // Ждем 2 секунды перед следующей попыткой
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }
    }
    private nowMs() {
        return Date.now() + this.timeOffset;
    }

    private getErrorMessage(error: unknown): string {
        if (error instanceof Error) return error.message;
        try { return JSON.stringify(error); } catch { return String(error); }
    }

    // ===== PUBLIC METHODS =====

    // 1) Информация об аккаунте
    public async getAccountInfo(): Promise<IAccountInfoBin> {
        try {
            const api = (this.client as any).restAPI;
            const ts = this.nowMs();

            let resp;

            if (this.isTestnet) {
                // --- TESTNET (USDS Futures) ---
                // Для тестнета используем V3, как вы просили
                resp = await api.accountInformationV3({
                    timestamp: ts,
                    recvWindow: 60000,
                });
            } else {
                // --- MAINNET (Portfolio Margin) ---
                // Для основного аккаунта используем стандартный метод
                resp = await api.accountInformation({
                    timestamp: ts,
                    recvWindow: 60000,
                });
            }

            const data = typeof resp?.data === 'function' ? await resp.data() : (resp?.data ?? resp);

            return data as IAccountInfoBin;

        } catch (err) {
            console.error('Error fetching Binance account info:', err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to fetch account info from Binance API: ${message}`);
        }
    }

    // 2) Позиции
    public async getPositionInfo(): Promise<IPositionInfoBin[]> {
        try {
            const ts = this.nowMs();
            const api = (this.client as any).restAPI;
            let resp;


            if (this.isTestnet) {

                resp = await api.positionInformationV3({
                    timestamp: ts,
                    recvWindow: 60000
                });
            } else {

                resp = await api.queryUmPositionInformation({
                    timestamp: ts,
                    recvWindow: 60000
                });
            }

            // Обработка ответа (в разных версиях SDK data может быть функцией или свойством)
            const data = typeof resp?.data === 'function' ? await resp.data() : (resp?.data ?? resp);

            return (Array.isArray(data) ? data : []) as IPositionInfoBin[];

        } catch (err) {
            console.error('Error fetching Binance position info:', err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to fetch position info from Binance API: ${message}`);
        }
    }

    // 3) Детальные позиции
    public async getDetailedPositions(): Promise<IDetailedPosition[]> {
        try {
            // --- ИСПРАВЛЕНИЕ ---
            // Эндпоинт fundingInfo НЕДОСТУПЕН на Testnet. 
            // Всегда берем метаданные об интервалах с Mainnet API.
            const fundingUrl = 'https://fapi.binance.com/fapi/v1/fundingInfo';

            const [positions, fundingInfoResponse] = await Promise.all([
                this.getPositionInfo(), // Позиции берем с текущего аккаунта (Testnet или Prod)
                axios.get(fundingUrl, { timeout: 10000 }).catch(() => ({ data: [] })), // Если упадет, вернем пустой массив (безопасно)
            ]);

            const fundingIntervals = new Map<string, number>();
            if (Array.isArray(fundingInfoResponse.data)) {
                for (const info of fundingInfoResponse.data) {
                    fundingIntervals.set(info.symbol, info.fundingIntervalHours);
                }
            }

            const openPositions = positions.filter(p => p.positionAmt && parseFloat(p.positionAmt) !== 0);

            const positionDetailsPromises = openPositions.map(async (position): Promise<IDetailedPosition> => {
                const symbol = position.symbol!;

                // А вот цены (Premium Index) нужно брать с ТОЙ ЖЕ сети, где мы торгуем!
                // Иначе цены будут отличаться.
                const premUrl = this.isTestnet
                    ? `https://testnet.binancefuture.com/fapi/v1/premiumIndex?symbol=${symbol}`
                    : `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`;

                // Добавим try-catch для запроса цены, чтобы не ломать всё из-за одной монеты
                let premiumIndexData: any = { lastFundingRate: '0' };
                try {
                    const res = await axios.get(premUrl, { timeout: 5000 });
                    premiumIndexData = res.data;
                } catch (e) {
                    console.warn(`[Binance] Failed to fetch premiumIndex for ${symbol}`);
                }

                const notional = Math.abs(parseFloat(position.notional!));
                const numericPositionAmt = parseFloat(position.positionAmt!);

                let fundingRate = parseFloat(premiumIndexData.lastFundingRate || '0') * 100; // %

                // Если интервал не нашли (например, в тестнете), считаем по дефолту 8 часов
                const interval = fundingIntervals.get(symbol) || 8;
                if (interval === 4) {
                    fundingRate *= 2;
                }

                return {
                    coin: symbol.replace(/USDT|USDC$/, ''),
                    notional: notional.toString(),
                    size: Math.abs(numericPositionAmt),
                    side: numericPositionAmt > 0 ? 'L' : 'S',
                    exchange: 'B',
                    fundingRate,
                    entryPrice: parseFloat(position.entryPrice || '0')
                };
            });

            const detailed = await Promise.all(positionDetailsPromises);

            return detailed;
        } catch (err) {
            console.error('Error fetching or processing Binance detailed positions:', err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to get detailed positions from Binance: ${message}`);
        }
    }

    // 4) Создание ордера (Testnet/Prod compatible)
    public async placeBinOrder(
        symbol: string,
        side: 'BUY' | 'SELL',
        quantity: number
    ): Promise<any> {
        try {
            const clientOrderId = `bot_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            console.log(`[Binance ${this.isTestnet ? 'TEST' : 'PROD'}] Placing MARKET ${side} ${quantity} ${symbol}. ClOrdID: ${clientOrderId}`);

            const api = (this.client as any).restAPI;

            const params = {
                symbol: symbol,
                side: side, // SDK принимает строки 'BUY'/'SELL' корректно
                type: 'MARKET',
                quantity: quantity,
                newClientOrderId: clientOrderId,
                timestamp: this.nowMs(),
                recvWindow: 60000,
            };

            let response;
            // В Testnet (Futures SDK) метод называется newOrder
            // В Prod (PM SDK) метод называется newUmOrder
            if (typeof api.newOrder === 'function') {
                response = await api.newOrder(params);
            } else if (typeof api.newUmOrder === 'function') {
                response = await api.newUmOrder(params);
            } else {
                throw new Error('No supported newOrder method found in SDK client');
            }

            const data = await response.data();
            return { ...data, clientOrderId };

        } catch (err) {
            console.error('Error placing Binance order:', err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to place order on Binance: ${message}`);
        }
    }

    // 5) Проверка статуса ордера
    public async getBinOrderInfo(symbol: string, clientOrderId: string): Promise<any> {
        try {
            const api = (this.client as any).restAPI;

            const params = {
                symbol: symbol,
                origClientOrderId: clientOrderId,
                timestamp: this.nowMs(),
                recvWindow: 60000,
            };

            let response;
            // В Testnet - queryOrder, в Prod - queryUmOrder
            if (typeof api.queryOrder === 'function') {
                response = await api.queryOrder(params);
            } else if (typeof api.queryUmOrder === 'function') {
                response = await api.queryUmOrder(params);
            } else {
                throw new Error('No supported queryOrder method found in SDK');
            }

            const data = typeof response?.data === 'function' ? await response.data() : (response?.data ?? response);
            return data;
        } catch (err) {
            console.error('Error fetching Binance order status:', err);
            // Возвращаем null, чтобы вызывающий код знал, что проверить не удалось, но не крашился
            return null;
        }
    }
    public async getOpenPosition(symbol: string): Promise<{ amt: string, entryPrice: string } | undefined> {
        try {
            // 1. Получаем все позиции (используя существующий метод)
            const positions = await this.getPositionInfo();

            // 2. Ищем нужную
            const pos = positions.find(p =>
                p.symbol === symbol &&
                p.positionAmt &&
                parseFloat(p.positionAmt) !== 0
            );

            // 3. Возвращаем в удобном формате
            if (!pos) return undefined;

            return {
                amt: pos.positionAmt!,
                entryPrice: pos.entryPrice || '0'
            };
        } catch (e) {
            console.error(`Error getting open position for ${symbol}:`, e);
            return undefined;
        }
    }

    // 6) Расчёт плеча
    public async calculateLeverage(): Promise<IExchangeData> {
        try {
            const [accountInfo, positionInfo] = await Promise.all([
                this.getAccountInfo(),
                this.getPositionInfo(),
            ]);

            const rawEquity = accountInfo.accountEquity || accountInfo.totalMarginBalance;

            const rawMaintMargin = accountInfo.accountMaintMargin || accountInfo.totalMaintMargin;

            if (!rawEquity || !rawMaintMargin) {
                console.error('[Binance Debug] Account Data:', accountInfo); // Покажет, что реально пришло
                throw new Error('Incomplete account data: Equity or MaintMargin is missing.');
            }

            const accountEquity = parseFloat(rawEquity);
            const accountMaintMargin = parseFloat(rawMaintMargin);

            if (isNaN(accountEquity) || isNaN(accountMaintMargin)) {
                throw new Error('Failed to parse financial data from API response.');
            }

            // 3. Считаем Notional (Сумма открытых позиций)
            const totalNotional = positionInfo.reduce((sum, position) => {
                return sum + Math.abs(parseFloat(position.notional || '0'));
            }, 0);
            const P_MM_keff = totalNotional ? (accountMaintMargin / totalNotional) : 0;
            // 4. Считаем плечо
            // Формула: Notional / (Equity - MaintMargin)
            // (Equity - MaintMargin) — это свободная маржа, доступная для потерь до ликвидации (примерно)
            // Иногда считают просто Notional / Equity, но ваш вариант консервативнее.
            const denominator = accountEquity - accountMaintMargin;

            if (denominator <= 0) {
                // Если маржа меньше поддерживающей, это почти ликвидация или ошибка данных
                if (totalNotional !== 0) {
                    // Возвращаем высокое плечо или ошибку
                    return { leverage: 999, accountEquity, P_MM_keff };
                }
                return { leverage: 0, accountEquity, P_MM_keff };
            }

            const leverage = totalNotional / denominator;

            if (!isFinite(leverage)) {
                throw new Error('Calculated leverage resulted in an infinite number.');
            }

            return { leverage, accountEquity, P_MM_keff };

        } catch (err) {
            console.error('Error during leverage calculation:', err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to calculate account leverage: ${message}`);
        }
    }

    // 7) Публичные данные (Цена)
    public async getExchangeData(symbol: string): Promise<IExchangeData> {
        // Динамический URL для тикера
        const baseUrl = this.isTestnet
            ? 'https://testnet.binancefuture.com'
            : 'https://fapi.binance.com';

        const url = `${baseUrl}/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`;

        try {
            const res = await axios.get(url, { timeout: 5000 });
            return res.data as IExchangeData;
        } catch (e) {
            console.error(`Error getting exchange data for ${symbol}:`, e);
            throw e;
        }
    }
    // Быстрый метод для Auto-Close (без фандинга и цен)
    public async getSimplePositions(): Promise<IDetailedPosition[]> {
        try {
            // Только 1 запрос!
            const positions = await this.getPositionInfo();

            return positions
                .filter(p => p.positionAmt && parseFloat(p.positionAmt) !== 0)
                .map(p => {
                    const amt = parseFloat(p.positionAmt!);
                    return {
                        coin: p.symbol!.replace(/USDT|USDC$/, ''), // Упрощенная нормализация
                        notional: '0', // Не тратим время на расчет
                        size: Math.abs(amt),
                        side: amt > 0 ? 'L' : 'S',
                        exchange: 'B',
                        fundingRate: 0, // Не нужно
                        entryPrice: 0   // Не нужно
                    };
                });
        } catch (err) {
            console.error('[Binance] Simple positions error:', err);
            return [];
        }
    }
}

export default BinanceService;