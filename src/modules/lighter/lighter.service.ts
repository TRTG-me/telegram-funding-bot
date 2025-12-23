import axios from 'axios';
import { Injectable } from '@nestjs/common';
import { LighterClient, ORDER_TYPE } from './lighter.client';
import { IExchangeData, IDetailedPosition, ILighterApiResponse, IFundingRatesResponseLighter } from '../../common/interfaces';

// Константа таймаута
const HTTP_TIMEOUT = 10000;

@Injectable()
export class LighterService {
    private readonly isTestnet: boolean;
    private readonly API_URL: string;
    private readonly l1Address: string;

    private readonly privateKey: string;
    private readonly apiKeyIndex: number;
    private readonly accountIndex: string | number;

    private tradeClient: LighterClient;

    constructor() {
        this.isTestnet = process.env.TESTNET === 'true';

        if (this.isTestnet) {
            console.log('🟡 [Lighter] Initializing in TESTNET mode');
            this.API_URL = 'https://testnet.zklighter.elliot.ai/api/v1';

            this.l1Address = process.env.LIGHTER_L1_ADDRESS_TEST || '';
            this.privateKey = process.env.LIGHTER_API_KEY_PRIVATE_KEY_TEST || '';
            this.apiKeyIndex = Number(process.env.LIGHTER_API_KEY_INDEX_TEST || 0);
            this.accountIndex = process.env.LIGHTER_ACCOUNT_INDEX_TEST || 0;
        } else {
            console.log('🟢 [Lighter] Initializing in MAINNET mode');
            this.API_URL = 'https://mainnet.zklighter.elliot.ai/api/v1';

            this.l1Address = process.env.LIGHTER_L1_ADDRESS || '';
            this.privateKey = process.env.LIGHTER_API_KEY_PRIVATE_KEY || '';
            this.apiKeyIndex = Number(process.env.LIGHTER_API_KEY_INDEX || 0);
            this.accountIndex = process.env.LIGHTER_ACCOUNT_INDEX || 0;
        }

        if (!this.l1Address) {
            throw new Error(`Lighter L1 Address is missing for ${this.isTestnet ? 'TESTNET' : 'MAINNET'} mode.`);
        }
        if (!this.privateKey) {
            console.warn(`⚠️ [Lighter] Private Key missing. Trading functions will not work.`);
        }

        this.tradeClient = new LighterClient({
            baseUrl: this.API_URL.replace('/api/v1', ''),
            privateKey: this.privateKey,
            apiKeyIndex: this.apiKeyIndex,
            accountIndex: this.accountIndex,
            chainId: this.isTestnet ? 300 : 304
        });

        this.tradeClient.init().catch(e => console.error('Lighter Client Init Error:', e));
    }

    public async checkSymbolExists(coin: string): Promise<boolean> {
        if (!this.tradeClient.isInitialized) {
            await this.tradeClient.init();
        }
        const marketId = this.tradeClient.getMarketId(coin);
        return marketId !== null;
    }

    public getMarketId(symbol: string): number | null {
        return this.tradeClient.getMarketId(symbol);
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

    private async getAccountData(): Promise<ILighterApiResponse> {
        try {
            const url = `${this.API_URL}/account?by=l1_address&value=${this.l1Address}`;
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

    public async getDetailedPositions(): Promise<IDetailedPosition[]> {
        try {
            // Добавил таймаут в запрос фандинга
            const [accountResponse, fundingResponse] = await Promise.all([
                this.getAccountData(),
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
            console.error('Error fetching Lighter detailed positions:', err);
            return [];
        }
    }

    // --- Trading Methods ---

    public async calculateLeverage(): Promise<IExchangeData> {
        try {
            const response = await this.getAccountData();

            const account = response?.accounts?.[0];
            if (!account || typeof account.total_asset_value !== 'string' || typeof account.available_balance !== 'string' || !Array.isArray(account.positions)) {
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
            console.error('Error during Lighter leverage calculation:', err);
            throw new Error(`Failed to calculate Lighter leverage: ${message}`);
        }
    }

    public async placeOrder(
        symbol: string,
        side: 'BUY' | 'SELL',
        amount: number,
        type: 'LIMIT' | 'MARKET' = 'LIMIT',
        price?: number
    ) {
        // Убеждаемся, что клиент инициализирован перед отправкой
        if (!this.tradeClient.isInitialized) {
            await this.tradeClient.init();
        }

        const marketId = this.tradeClient.getMarketId(symbol);

        if (marketId === null) {
            throw new Error(`Symbol '${symbol}' not found on Lighter exchange!`);
        }

        console.log(`[Lighter] Found Market ID for ${symbol}: ${marketId}`);

        const isAsk = side === 'SELL';
        const orderType = type === 'MARKET' ? ORDER_TYPE.MARKET : ORDER_TYPE.LIMIT;

        const result = await this.tradeClient.placeOrder({
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

    private async pollTransactionDetails(txHash: string, marketId: number, fallbackQty: number, fallbackPrice: number) {
        const maxAttempts = 20;

        for (let i = 0; i < maxAttempts; i++) {
            await new Promise(r => setTimeout(r, 1000));

            // Этот метод внутри tradeClient (getTransactionByHash) тоже должен быть защищен таймаутом, 
            // если вы имеете доступ к его коду.
            const txData = await this.tradeClient.getTransactionByHash(txHash);

            if (txData && txData.event_info) {
                console.log(`✅ [Lighter] Transaction confirmed on attempt ${i + 1}!`);

                try {
                    const eventInfo = JSON.parse(txData.event_info);
                    const trade = eventInfo.t;

                    if (trade && parseFloat(trade.s) > 0) {
                        const market = this.tradeClient.markets[marketId];
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
    public async getSimplePositions(): Promise<IDetailedPosition[]> {
        try {
            // Только 1 запрос!
            const response = await this.getAccountData();
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