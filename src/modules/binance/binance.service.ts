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
import { UserService } from '../users/users.service';

export class BinanceService {
    // Дефолтный клиент (из .env)
    private defaultClient: DerivativesTradingPortfolioMargin | DerivativesTradingUsdsFutures;
    // Кеш клиентов для юзеров
    private clients = new Map<number, DerivativesTradingPortfolioMargin | DerivativesTradingUsdsFutures>();

    private readonly isTestnet: boolean;
    private timeOffset = 0;
    private lastRttMs = 0;

    constructor(private userService?: UserService) {
        // 1. Определение режима из .env
        this.isTestnet = process.env.TESTNET === 'true';
        if (this.isTestnet) {
            console.log('🟡 [Binance] Initializing in TESTNET mode');
        } else {
            console.log('🟢 [Binance] Initializing in MAINNET mode');
        }

        // Инициализация дефолтного клиента (для обратной совместимости)
        this.defaultClient = this.createClient(
            this.isTestnet ? process.env.BINANCE_API_KEY_TEST : process.env.BINANCE_API_KEY,
            this.isTestnet ? process.env.BINANCE_API_SECRET_TEST : process.env.BINANCE_API_SECRET
        );

        // Синхронизация времени
        this.syncTime().catch(() => { });
        setInterval(() => this.syncTime().catch(() => { }), 60_000);
    }

    // Хелпер создания клиента
    private createClient(apiKey?: string, apiSecret?: string): any {
        if (!apiKey || !apiSecret) {
            console.warn(`[Binance] Keys missing for ${this.isTestnet ? 'TESTNET' : 'MAINNET'}. Default client might fail.`);
            // Возвращаем заглушку или null, но лучше пусть упадет при попытке вызова, чем при старте
            return null;
        }

        const basePath = this.isTestnet
            ? DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL
            : DERIVATIVES_TRADING_PORTFOLIO_MARGIN_REST_API_PROD_URL;

        const config = {
            apiKey,
            apiSecret,
            basePath,
            recvWindow: 60000,
            timeout: 30000
        };

        if (this.isTestnet) {
            return new DerivativesTradingUsdsFutures({ configurationRestAPI: config });
        } else {
            return new DerivativesTradingPortfolioMargin({ configurationRestAPI: config });
        }
    }

    // Получение клиента для конкретного юзера (или дефолтного)
    private async getClient(userId?: number): Promise<any> {
        // Если юзер не указан - используем дефолтный (.env) только для системных операций
        if (!userId) {
            if (!this.userService) {
                return this.defaultClient;
            }
            throw new Error('[Binance] userId is required for user operations');
        }

        // Проверяем кеш
        if (this.clients.has(userId)) {
            return this.clients.get(userId);
        }

        // Проверка наличия UserService
        if (!this.userService) {
            throw new Error('[Binance] UserService not available');
        }

        // Ищем в БД
        const user = await this.userService.getUser(userId);
        if (!user) {
            throw new Error(`[Binance] User ${userId} not found in database`);
        }

        // Достаем ключи
        const apiKey = this.isTestnet ? user.binanceApiKeyTest : user.binanceApiKey;
        const apiSecret = this.isTestnet ? user.binanceApiSecretTest : user.binanceApiSecret;

        // Строгая проверка: ключи ОБЯЗАТЕЛЬНЫ
        if (!apiKey || !apiSecret) {
            throw new Error(`[Binance] User ${userId} has no API keys configured. Please add keys to database.`);
        }

        // Создаем и кешируем
        const client = this.createClient(apiKey, apiSecret);
        if (!client) {
            throw new Error(`[Binance] Failed to create client for user ${userId}`);
        }

        this.clients.set(userId, client);
        return client;
    }

    private async syncTime() {
        // ... (без изменений, но для краткости повторю суть)
        // Синхронизация времени глобальна, она не зависит от API ключей, 
        // поэтому смещение timeOffset можно использовать общее.
        const url = this.isTestnet
            ? 'https://testnet.binancefuture.com/fapi/v1/time'
            : 'https://fapi.binance.com/fapi/v1/time';

        let attempts = 0;
        const maxAttempts = 10;

        while (attempts < maxAttempts) {
            try {
                const start = Date.now();
                const r = await axios.get(url, { timeout: 5000 });
                const end = Date.now();

                const serverTime = r.data.serverTime as number;
                this.lastRttMs = end - start;
                this.timeOffset = serverTime - end;
                return;

            } catch (e: any) {
                attempts++;
                if (attempts === maxAttempts) {
                    console.error('[Binance] CRITICAL: Time sync failed. Trading might fail.');
                    this.timeOffset = 0;
                } else {
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
    public async getAccountInfo(userId?: number): Promise<IAccountInfoBin> {
        try {
            const client = await this.getClient(userId);
            const api = (client as any).restAPI; // Доступ к restAPI
            const ts = this.nowMs();

            let resp;

            if (this.isTestnet) {
                resp = await api.accountInformationV3({ timestamp: ts, recvWindow: 60000 });
            } else {
                resp = await api.accountInformation({ timestamp: ts, recvWindow: 60000 });
            }

            const data = typeof resp?.data === 'function' ? await resp.data() : (resp?.data ?? resp);
            return data as IAccountInfoBin;

        } catch (err) {
            console.error(`Error fetching Binance account info (User: ${userId}):`, err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to fetch account info from Binance API: ${message}`);
        }
    }

    // 2) Позиции
    public async getPositionInfo(userId?: number): Promise<IPositionInfoBin[]> {
        try {
            const client = await this.getClient(userId);
            const api = (client as any).restAPI;
            const ts = this.nowMs();
            let resp;

            if (this.isTestnet) {
                resp = await api.positionInformationV3({ timestamp: ts, recvWindow: 60000 });
            } else {
                resp = await api.queryUmPositionInformation({ timestamp: ts, recvWindow: 60000 });
            }

            const data = typeof resp?.data === 'function' ? await resp.data() : (resp?.data ?? resp);
            return (Array.isArray(data) ? data : []) as IPositionInfoBin[];

        } catch (err) {
            console.error(`Error fetching Binance position info (User: ${userId}):`, err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to fetch position info from Binance API: ${message}`);
        }
    }

    // 3) Детальные позиции
    public async getDetailedPositions(userId?: number): Promise<IDetailedPosition[]> {
        try {
            // Метаданные берем, как и раньше
            const fundingUrl = 'https://fapi.binance.com/fapi/v1/fundingInfo';

            const [positions, fundingInfoResponse] = await Promise.all([
                this.getPositionInfo(userId),
                axios.get(fundingUrl, { timeout: 10000 }).catch(() => ({ data: [] })),
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
                // Premium Index - публичный метод, не зависит от ключей, 
                // можно использовать axios напрямую
                const premUrl = this.isTestnet
                    ? `https://testnet.binancefuture.com/fapi/v1/premiumIndex?symbol=${symbol}`
                    : `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`;

                let premiumIndexData: any = { lastFundingRate: '0' };
                try {
                    const res = await axios.get(premUrl, { timeout: 5000 });
                    premiumIndexData = res.data;
                } catch (e) {
                    console.warn(`[Binance] Failed to fetch premiumIndex for ${symbol}`);
                }

                const notional = Math.abs(parseFloat(position.notional!));
                const numericPositionAmt = parseFloat(position.positionAmt!);
                let fundingRate = parseFloat(premiumIndexData.lastFundingRate || '0') * 100;

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

            return await Promise.all(positionDetailsPromises);
        } catch (err) {
            console.error(`Error fetching Binance detailed positions (User: ${userId}):`, err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to get detailed positions: ${message}`);
        }
    }

    // 4) Создание ордера
    public async placeBinOrder(
        symbol: string,
        side: 'BUY' | 'SELL',
        quantity: number,
        userId?: number // <-- ADDED
    ): Promise<any> {
        try {
            const clientOrderId = `bot_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            console.log(`[Binance ${this.isTestnet ? 'TEST' : 'PROD'}] Placing MARKET ${side} ${quantity} ${symbol}. ClOrdID: ${clientOrderId} (User: ${userId || 'Env'})`);

            const client = await this.getClient(userId);
            const api = (client as any).restAPI;

            const params = {
                symbol: symbol,
                side: side,
                type: 'MARKET',
                quantity: quantity,
                newClientOrderId: clientOrderId,
                timestamp: this.nowMs(),
                recvWindow: 60000,
            };

            let response;
            if (typeof api.newOrder === 'function') {
                response = await api.newOrder(params);
            } else if (typeof api.newUmOrder === 'function') {
                response = await api.newUmOrder(params);
            } else {
                throw new Error('No supported newOrder method found');
            }

            const data = await response.data();
            return { ...data, clientOrderId };

        } catch (err) {
            console.error(`Error placing Binance order (User: ${userId}):`, err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to place order on Binance: ${message}`);
        }
    }

    // 5) Статус ордера
    public async getBinOrderInfo(symbol: string, clientOrderId: string, userId?: number): Promise<any> {
        try {
            const client = await this.getClient(userId);
            const api = (client as any).restAPI;

            const params = {
                symbol: symbol,
                origClientOrderId: clientOrderId,
                timestamp: this.nowMs(),
                recvWindow: 60000,
            };

            let response;
            if (typeof api.queryOrder === 'function') {
                response = await api.queryOrder(params);
            } else if (typeof api.queryUmOrder === 'function') {
                response = await api.queryUmOrder(params);
            } else {
                throw new Error('No supported queryOrder method found');
            }

            const data = typeof response?.data === 'function' ? await response.data() : (response?.data ?? response);
            return data;
        } catch (err: any) {
            if (err?.message && (
                err.message.includes('Order does not exist') ||
                err.message.includes('Order was not found')
            )) {
                return null;
            }

            console.error(`Error fetching Binance order status (User: ${userId}):`, err);
            return null;
        }
    }

    // 6) Отдельная позиция
    public async getOpenPosition(symbol: string, userId?: number): Promise<{ amt: string, entryPrice: string } | undefined> {
        try {
            const positions = await this.getPositionInfo(userId);
            const pos = positions.find(p =>
                p.symbol === symbol &&
                p.positionAmt &&
                parseFloat(p.positionAmt) !== 0
            );

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

    // 7) Плечо (нужно инфо об аккаунте)
    public async calculateLeverage(userId?: number): Promise<IExchangeData> {
        try {
            const [accountInfo, positionInfo] = await Promise.all([
                this.getAccountInfo(userId),
                this.getPositionInfo(userId),
            ]);

            const rawEquity = accountInfo.accountEquity || accountInfo.totalMarginBalance;
            const rawMaintMargin = accountInfo.accountMaintMargin || accountInfo.totalMaintMargin;

            if (!rawEquity || !rawMaintMargin) {
                // Если данные не пришли - варнинг и выход
                // console.warn('[Binance] Incomplete data for leverage calc');
                throw new Error('Incomplete account data');
            }

            const accountEquity = parseFloat(rawEquity);
            const accountMaintMargin = parseFloat(rawMaintMargin);

            const totalNotional = positionInfo.reduce((sum, position) => {
                return sum + Math.abs(parseFloat(position.notional || '0'));
            }, 0);
            const P_MM_keff = totalNotional ? (accountMaintMargin / totalNotional) : 0;

            const denominator = accountEquity - accountMaintMargin;
            if (denominator <= 0) {
                if (totalNotional !== 0) return { leverage: 999, accountEquity, P_MM_keff };
                return { leverage: 0, accountEquity, P_MM_keff };
            }

            const leverage = totalNotional / denominator;
            return { leverage, accountEquity, P_MM_keff };

        } catch (err) {
            console.error(`Error during leverage calculation (User: ${userId}):`, err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to calculate account leverage: ${message}`);
        }
    }

    // 8) Цены (публичные)
    public async getExchangeData(symbol: string): Promise<IExchangeData> {
        // ... старый код (он публичный, userId не нужен)
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

    // 9) Простые позиции для Auto-Close
    public async getSimplePositions(userId?: number): Promise<IDetailedPosition[]> {
        try {
            const positions = await this.getPositionInfo(userId);

            return positions
                .filter(p => p.positionAmt && parseFloat(p.positionAmt) !== 0)
                .map(p => {
                    const amt = parseFloat(p.positionAmt!);
                    return {
                        coin: p.symbol!.replace(/USDT|USDC$/, ''),
                        notional: '0',
                        size: Math.abs(amt),
                        side: amt > 0 ? 'L' : 'S',
                        exchange: 'B',
                        fundingRate: 0,
                        entryPrice: 0
                    };
                });
        } catch (err) {
            console.error('[Binance] Simple positions error:', err);
            return [];
        }
    }
}


export default BinanceService;