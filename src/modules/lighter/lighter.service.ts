import axios from 'axios';
import { Injectable } from '@nestjs/common';
import { LighterClient, ORDER_TYPE } from './lighter.client';
import { IExchangeData, IDetailedPosition, ILighterApiResponse, IFundingRatesResponseLighter } from '../../common/interfaces';
import { UserService } from '../users/users.service';

// Константа таймаута
const HTTP_TIMEOUT = 10000;

interface LighterContext {
    client: LighterClient;
    l1Address: string;
}

@Injectable()
export class LighterService {
    private readonly isTestnet: boolean;
    private readonly API_URL: string;

    // private defaultContext: LighterContext; // Removed
    private userContexts = new Map<number, LighterContext>();

    constructor(private userService: UserService) {
        this.isTestnet = process.env.TESTNET === 'true';

        if (this.isTestnet) {
            console.log('🟡 [Lighter] Initializing in TESTNET mode');
            this.API_URL = 'https://testnet.zklighter.elliot.ai/api/v1';
        } else {
            console.log('🟢 [Lighter] Initializing in MAINNET mode');
            this.API_URL = 'https://mainnet.zklighter.elliot.ai/api/v1';
        }
    }

    private createContext(l1Address: string, privateKey: string, apiKeyIndex: number = 0, accountIndex: string | number = 0): LighterContext {
        let client: LighterClient = null as any; // Allow null initially if credentials missing

        if (l1Address && privateKey) {
            client = new LighterClient({
                baseUrl: this.API_URL.replace('/api/v1', ''),
                privateKey: privateKey,
                apiKeyIndex: apiKeyIndex,
                accountIndex: accountIndex,
                chainId: this.isTestnet ? 300 : 304
            });
        }

        return {
            client,
            l1Address
        };
    }

    private async getContext(userId?: number): Promise<LighterContext> {
        if (!userId) {
            throw new Error('[Lighter] userId is required for all operations');
        }

        if (this.userContexts.has(userId)) return this.userContexts.get(userId)!;

        // Проверка наличия UserService
        if (!this.userService) {
            throw new Error('[Lighter] UserService not available');
        }

        const user = await this.userService.getUser(userId);
        if (!user) {
            throw new Error(`[Lighter] User ${userId} not found in database`);
        }

        const l1Address = this.isTestnet ? user.lighterTestL1Address : user.lighterL1Address;
        const privateKey = this.isTestnet ? user.lighterTestPrivateKey : user.lighterPrivateKey;

        // Строгая проверка: ключи ОБЯЗАТЕЛЬНЫ
        if (!l1Address || !privateKey) {
            throw new Error(`[Lighter] User ${userId} has no API keys configured. Please add keys to database.`);
        }

        const apiKeyIndex = this.isTestnet ? (user.lighterTestApiKeyIndex ?? 0) : (user.lighterApiKeyIndex ?? 0);
        const accountIndex = this.isTestnet ? (user.lighterTestAccountIndex ?? 0) : (user.lighterAccountIndex ?? 0);

        const ctx = this.createContext(l1Address, privateKey, apiKeyIndex, accountIndex);

        if (ctx.client) {
            ctx.client.init().catch(e => console.error(`Lighter Client Init Error for user ${userId}:`, e));
        }

        this.userContexts.set(userId, ctx);
        return ctx;
    }

    public async checkSymbolExists(coin: string, userId?: number): Promise<boolean> {
        const ctx = await this.getContext(userId);
        if (!ctx.client) return false;

        if (!ctx.client.isInitialized) {
            await ctx.client.init();
        }
        const marketId = ctx.client.getMarketId(coin);
        return marketId !== null;
    }

    public async getMarketId(symbol: string, userId?: number): Promise<number | null> {
        const ctx = await this.getContext(userId);
        if (!ctx.client) return null;

        if (!ctx.client.isInitialized) {
            await ctx.client.init();
        }

        return ctx.client.getMarketId(symbol);
    }

    private getErrorMessage(error: unknown): string {
        if (axios.isAxiosError(error)) {
            if (error.code === 'ECONNABORTED') return 'Network Timeout';
            return JSON.stringify(error.response?.data) || error.message;
        }
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }

    // --- Data Methods with Timeouts ---

    private async getAccountData(ctx: LighterContext): Promise<ILighterApiResponse> {
        try {
            if (!ctx.l1Address) return {} as ILighterApiResponse;

            const url = `${this.API_URL}/account?by=l1_address&value=${ctx.l1Address}`;
            // Добавил таймаут
            const response = await axios.get<ILighterApiResponse>(url, {
                headers: { 'accept': 'application/json' },
                timeout: HTTP_TIMEOUT
            });
            return response.data;
        } catch (error) {
            throw new Error(`Failed to fetch Lighter account data: ${this.getErrorMessage(error)}`);
        }
    }

    public async getDetailedPositions(userId?: number): Promise<IDetailedPosition[]> {
        try {
            const ctx = await this.getContext(userId);
            if (!ctx.l1Address) return [];

            // Добавил таймаут в запрос фандинга
            const [accountResponse, fundingResponse] = await Promise.all([
                this.getAccountData(ctx),
                axios.get<IFundingRatesResponseLighter>(`${this.API_URL}/funding-rates`, { timeout: HTTP_TIMEOUT })
            ]);

            const account = accountResponse?.accounts?.[0];
            const fundingRates = fundingResponse?.data?.funding_rates;

            if (!account || !account.positions) {
                return [];
            }

            const fundingMap = new Map<string, number>();
            if (Array.isArray(fundingRates)) {
                fundingRates
                    .filter(rate => rate.exchange === 'lighter')
                    .forEach(rate => fundingMap.set(rate.symbol, rate.rate));
            }

            const detailedPositions: IDetailedPosition[] = account.positions
                .filter(p => parseFloat(p.position || '0') !== 0)
                .map(position => {
                    const coin = position.symbol || 'UNKNOWN';
                    const fundingRate = (fundingMap.get(coin) || 0) * 100;
                    const rawSize = parseFloat(position.position || '0');
                    const rawValue = parseFloat(position.position_value || '0');
                    const entryPrice = parseFloat(position.avg_entry_price || '0');

                    return {
                        coin: coin,
                        notional: Math.abs(rawValue).toString(),
                        size: Math.abs(rawSize),
                        side: position.sign === 1 ? 'L' : 'S',
                        exchange: 'L',
                        fundingRate: fundingRate,
                        entryPrice: entryPrice
                    };
                });

            return detailedPositions;

        } catch (err) {
            const message = this.getErrorMessage(err);
            // Don't spam cache errors for inactive users
            if (userId) console.error(`Error fetching Lighter detailed positions (User ${userId}):`, err);
            return [];
        }
    }

    // --- Trading Methods ---

    public async getLiveFundingRate(coin: string): Promise<number> {
        try {
            const fundingResponse = await axios.get<IFundingRatesResponseLighter>(`${this.API_URL}/funding-rates`, { timeout: HTTP_TIMEOUT });
            const fundingRates = fundingResponse?.data?.funding_rates;
            if (!Array.isArray(fundingRates)) return 0;

            const rate = fundingRates.find(r => r.exchange === 'lighter' && (r.symbol === coin || r.symbol.includes(coin)));
            if (!rate) return 0;

            return rate.rate * 3 * 365 * 100; // Lighter uses 8h segments
        } catch (e) {
            return 0;
        }
    }

    public async calculateLeverage(userId?: number): Promise<IExchangeData> {
        try {
            const ctx = await this.getContext(userId);
            const response = await this.getAccountData(ctx);

            const account = response?.accounts?.[0];
            if (!account || typeof account.total_asset_value !== 'string' || typeof account.available_balance !== 'string' || !Array.isArray(account.positions)) {
                // Silent fail for empty accounts
                if (!account) return { leverage: 0, accountEquity: 0, P_MM_keff: 0 };
                throw new Error('Incomplete or invalid data received from Lighter API.');
            }

            const totalAssetValue = parseFloat(account.total_asset_value);
            const availableBalance = parseFloat(account.available_balance);

            if (isNaN(totalAssetValue) || isNaN(availableBalance)) {
                throw new Error('Failed to parse financial data from Lighter API response.');
            }

            const totalPositionValue = account.positions
                .filter(p => parseFloat(p.position || '0') !== 0)
                .reduce((sum, p) => sum + Math.abs(parseFloat(p.position_value || '0')), 0);

            if (totalPositionValue === 0) {
                return { leverage: 0, accountEquity: totalAssetValue, P_MM_keff: 0 };
            }

            const maintenanceMargin = (totalAssetValue - availableBalance) * 0.6;
            const P_MM_keff = totalPositionValue ? (maintenanceMargin / totalPositionValue) : 0;
            const denominator = totalAssetValue - maintenanceMargin;

            if (denominator <= 0) {
                // Если маржа почти кончилась, возвращаем высокое плечо
                return { leverage: 999, accountEquity: totalAssetValue, P_MM_keff };
            }

            const leverage = totalPositionValue / denominator;
            if (!isFinite(leverage)) {
                throw new Error('Leverage calculation resulted in a non-finite number.');
            }

            return { leverage, accountEquity: totalAssetValue, P_MM_keff };

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error(`Error during Lighter leverage calculation (User ${userId}):`, err);
            // throw new Error(`Failed to calculate Lighter leverage: ${message}`);
            return { leverage: 0, accountEquity: 0, P_MM_keff: 0 };
        }
    }

    public async placeOrder(
        symbol: string,
        side: 'BUY' | 'SELL',
        amount: number,
        userId?: number,
        type: 'LIMIT' | 'MARKET' = 'LIMIT',
        price?: number
    ) {
        const ctx = await this.getContext(userId);
        if (!ctx.client) throw new Error('Lighter client not initialized (no keys?)');

        // Убеждаемся, что клиент инициализирован перед отправкой
        if (!ctx.client.isInitialized) {
            await ctx.client.init();
        }

        const marketId = ctx.client.getMarketId(symbol);

        if (marketId === null) {
            throw new Error(`Symbol '${symbol}' not found on Lighter exchange!`);
        }

        console.log(`[Lighter] Found Market ID for ${symbol}: ${marketId} (User ${userId})`);

        const isAsk = side === 'SELL';
        const orderType = type === 'MARKET' ? ORDER_TYPE.MARKET : ORDER_TYPE.LIMIT;

        const result = await ctx.client.placeOrder({
            marketId,
            isAsk,
            orderType,
            amount,
            price,
            slippage: 0.05
        });

        console.log(`✅ [Lighter] Order SENT. TxHash: ${result.txHash}`);

        const fallbackPrice = price || 0;
        const fillDetails = await this.pollTransactionDetails(
            ctx.client, // Pass user-specific client for polling
            result.txHash,
            marketId,
            amount,
            fallbackPrice
        );

        return {
            success: true,
            orderId: result.sentNonce,
            txHash: result.txHash,
            ...fillDetails
        };
    }

    private async pollTransactionDetails(client: LighterClient, txHash: string, marketId: number, fallbackQty: number, fallbackPrice: number) {
        // ОПТИМИЗАЦИЯ ДЛЯ AUTO-CLOSE: Ждем всего 7 секунд (вместо 20)
        // Если за 7 сек не прошло - считаем сбоем, чтобы успеть закрыть вторую ногу.
        const maxAttempts = 7;

        for (let i = 0; i < maxAttempts; i++) {
            await new Promise(r => setTimeout(r, 1000));

            const txData = await client.getTransactionByHash(txHash);

            if (txData && txData.event_info) {
                console.log(`✅ [Lighter] Transaction confirmed on attempt ${i + 1}!`);

                try {
                    const eventInfo = JSON.parse(txData.event_info);
                    const trade = eventInfo.t;

                    if (trade && parseFloat(trade.s) > 0) {
                        const market = client.markets[marketId];
                        const sizeMult = 10 ** market.sizeDecimals;
                        const priceMult = 10 ** market.priceDecimals;

                        const rawPrice = parseFloat(trade.p);
                        const rawSize = parseFloat(trade.s);

                        const realAvgPrice = rawPrice / priceMult;
                        const realFilledQty = rawSize / sizeMult;

                        const isFullyFilled = (eventInfo.to && eventInfo.to.rs === 0);
                        const status = isFullyFilled ? 'FILLED' : 'PARTIALLY_FILLED';

                        console.log(`📊 Executed: ${realFilledQty} @ ${realAvgPrice}`);

                        return {
                            avgPrice: realAvgPrice,
                            filledQty: realFilledQty,
                            status: status
                        };
                    }
                    else {
                        console.log(`🕒 [Lighter] Order placed in book (Maker). No fill yet.`);
                        return {
                            avgPrice: fallbackPrice,
                            filledQty: fallbackQty,
                            status: 'OPEN'
                        };
                    }

                } catch (e) {
                    console.warn('[Lighter] JSON parse error:', e);
                }
            }
        }

        console.log(`\n⚠️ [Lighter] Tx polling timeout. Assuming success.`);

        return {
            avgPrice: fallbackPrice,
            filledQty: fallbackQty,
            status: 'ASSUMED_FILLED'
        };
    }
    // --- Оптимизированный метод для Auto-Close ---
    // Убрали запрос funding-rates
    public async getSimplePositions(userId?: number): Promise<IDetailedPosition[]> {
        try {
            const ctx = await this.getContext(userId);
            if (!ctx.l1Address) return [];

            // Только 1 запрос!
            const response = await this.getAccountData(ctx);
            const account = response?.accounts?.[0];

            if (!account || !account.positions) {
                return [];
            }

            return account.positions
                .filter(p => parseFloat(p.position || '0') !== 0)
                .map(position => {
                    const rawSize = parseFloat(position.position || '0');

                    return {
                        coin: position.symbol || 'UNKNOWN',
                        notional: '0',
                        size: Math.abs(rawSize),
                        side: position.sign === 1 ? 'L' : 'S',
                        exchange: 'L',
                        fundingRate: 0, // Не тратим время
                        entryPrice: 0
                    };
                });

        } catch (err) {
            console.error('[Lighter] Simple positions error:', err);
            return [];
        }
    }
}
