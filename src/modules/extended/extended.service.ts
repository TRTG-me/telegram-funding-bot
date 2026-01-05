import axios from 'axios';
import { randomUUID } from 'crypto';
import { ec, num, shortString, constants } from 'starknet';
import { poseidonHashMany } from '@scure/starknet';

import {
    IExchangeData,
    IDetailedPosition,
    IExtendedApiResponse,
    IExtendedMarketStatsResponse,
    IExtendedPositionsResponse
} from '../../common/interfaces';
import { UserService } from '../users/users.service';

// Настройки
const CONFIG = {
    DEFAULT_SLIPPAGE: 0.0075, // 0.75%
    EXPIRATION_HOURS: 1,
    HTTP_TIMEOUT: 10000 // <--- НОВОЕ: 10 секунд на запрос
};

interface ExtendedContext {
    apiKey: string;
    privateKey: string;
    publicKey: string;
    vaultId: string;
}

export class ExtendedService {
    private readonly isTestnet: boolean;
    private readonly apiUrl: string;

    // private defaultContext: ExtendedContext; // Removed
    private userContexts = new Map<number, ExtendedContext>();

    constructor(private userService: UserService) {
        this.isTestnet = process.env.TESTNET === 'true';

        this.apiUrl = this.isTestnet
            ? 'https://api.starknet.sepolia.extended.exchange/api/v1'
            : 'https://api.starknet.extended.exchange/api/v1';

        if (this.isTestnet) {
            console.log('🟡 [Extended] Initializing in TESTNET mode');
        } else {
            console.log('🟢 [Extended] Initializing in MAINNET mode');
        }
    }

    private createContext(apiKey: string, privateKey: string, publicKey: string, vaultId: string): ExtendedContext {
        return { apiKey, privateKey, publicKey, vaultId };
    }

    private async getContext(userId?: number): Promise<ExtendedContext> {
        if (!userId) {
            throw new Error('[Extended] userId is required for all operations');
        }

        if (this.userContexts.has(userId)) return this.userContexts.get(userId)!;

        // Проверка наличия UserService
        if (!this.userService) {
            throw new Error('[Extended] UserService not available');
        }

        const user = await this.userService.getUser(userId);
        if (!user) {
            throw new Error(`[Extended] User ${userId} not found in database`);
        }

        const apiKey = this.isTestnet ? user.extendedTestApiKey : user.extendedApiKey;
        const privateKey = this.isTestnet ? user.extendedTestStarkPrivateKey : user.extendedStarkPrivateKey;
        const publicKey = this.isTestnet ? user.extendedTestStarkPublicKey : user.extendedStarkPublicKey;
        const vaultId = this.isTestnet ? user.extendedTestVaultId : user.extendedVaultId;

        // Строгая проверка: ключи ОБЯЗАТЕЛЬНЫ
        if (!apiKey || !privateKey || !publicKey || !vaultId) {
            throw new Error(`[Extended] User ${userId} has no API keys configured. Please add keys to database.`);
        }

        const ctx = this.createContext(apiKey, privateKey, publicKey, vaultId.toString());
        this.userContexts.set(userId, ctx);
        return ctx;
    }

    private getErrorMessage(error: unknown): string {
        if (axios.isAxiosError(error)) {
            // Если таймаут
            if (error.code === 'ECONNABORTED') return 'Network Timeout';
            return JSON.stringify(error.response?.data) || error.message;
        }
        if (error instanceof Error) return error.message;
        return String(error);
    }

    // =========================================================================
    // --- 1. DATA FETCHING METHODS ---
    // =========================================================================

    private async getAccountBalance(ctx: ExtendedContext): Promise<IExtendedApiResponse> {
        try {
            if (!ctx.apiKey) return {} as IExtendedApiResponse;

            const response = await axios.get(`${this.apiUrl}/user/balance`, {
                headers: { 'X-Api-Key': ctx.apiKey, 'Content-Type': 'application/json' },
                timeout: CONFIG.HTTP_TIMEOUT
            });
            return response.data;
        } catch (error) {
            throw new Error(`Failed to fetch balance: ${this.getErrorMessage(error)}`);
        }
    }

    private async getUserPositions(ctx: ExtendedContext): Promise<IExtendedPositionsResponse> {
        try {
            if (!ctx.apiKey) return {} as IExtendedPositionsResponse;

            const response = await axios.get(`${this.apiUrl}/user/positions`, {
                headers: { 'X-Api-Key': ctx.apiKey, 'Content-Type': 'application/json' },
                timeout: CONFIG.HTTP_TIMEOUT
            },);
            return response.data;
        } catch (error) {
            throw new Error(`Failed to fetch positions: ${this.getErrorMessage(error)}`);
        }
    }

    public async getDetailedPositions(userId?: number): Promise<IDetailedPosition[]> {
        try {
            const ctx = await this.getContext(userId);
            if (!ctx.apiKey) return [];

            const positionsResponse = await this.getUserPositions(ctx);
            if (positionsResponse.status !== 'OK' || !Array.isArray(positionsResponse.data)) {
                if (positionsResponse.status === 'OK') return [];
                throw new Error('Invalid positions data');
            }

            const openPositions = positionsResponse.data.filter(p => p.status === 'OPENED');

            const detailedPositionsPromises = openPositions.map(async (position): Promise<IDetailedPosition> => {
                const market = position.market;
                // <--- Added Timeout here inside the loop
                try {
                    const statsResponse = await axios.get<IExtendedMarketStatsResponse>(
                        `${this.apiUrl}/info/markets/${market}/stats`,
                        { timeout: CONFIG.HTTP_TIMEOUT }
                    );
                    const fundingRateData = statsResponse.data?.data?.fundingRate || '0';
                    const fundingRate = parseFloat(fundingRateData) * 8 * 100;

                    return {
                        coin: market.replace(/-USD$/, ''),
                        notional: position.value,
                        size: Math.abs(parseFloat(position.size)),
                        side: position.side === 'LONG' ? 'L' : 'S',
                        exchange: 'E',
                        fundingRate: fundingRate,
                        entryPrice: parseFloat(position.openPrice || '0')
                    };
                } catch (e) {
                    return {
                        coin: market.replace(/-USD$/, ''),
                        notional: position.value,
                        size: Math.abs(parseFloat(position.size)),
                        side: position.side === 'LONG' ? 'L' : 'S',
                        exchange: 'E',
                        fundingRate: 0,
                        entryPrice: parseFloat(position.openPrice || '0')
                    };
                }
            });
            return Promise.all(detailedPositionsPromises);
        } catch (err) {
            if (userId) console.error('Error fetching Extended positions:', err);
            return [];
        }
    }

    public async getOpenPosition(symbol: string, userId?: number): Promise<IDetailedPosition | undefined> {
        const cleanSymbol = symbol.replace('-USD', '');
        const allPositions = await this.getDetailedPositions(userId);
        return allPositions.find(p => p.coin === cleanSymbol);
    }

    public async getLiveFundingRate(coin: string): Promise<number> {
        try {
            const market = coin.endsWith('-USD') ? coin : `${coin}-USD`;
            const statsResponse = await axios.get<IExtendedMarketStatsResponse>(
                `${this.apiUrl}/info/markets/${market}/stats`,
                { timeout: CONFIG.HTTP_TIMEOUT }
            );
            const fundingRateData = statsResponse.data?.data?.fundingRate || '0';
            return parseFloat(fundingRateData) * 24 * 365 * 100;
        } catch (e) {
            return 0;
        }
    }

    public async calculateLeverage(userId?: number): Promise<IExchangeData> {
        try {
            const ctx = await this.getContext(userId);

            const response = await this.getAccountBalance(ctx);
            const data = response?.data;
            if (!data) return { leverage: 0, accountEquity: 0, P_MM_keff: 0 };

            const exposure = parseFloat(data.exposure || '0');
            const equity = parseFloat(data.equity || '0');
            const initialMargin = parseFloat(data.initialMargin || '0');
            const maintMargin = initialMargin / 2;
            const P_MM_keff = exposure ? (maintMargin / exposure) : 0;

            if (exposure === 0 || equity === 0) return { leverage: 0, accountEquity: equity, P_MM_keff };

            const denominator = equity - maintMargin;
            if (denominator <= 0) return { leverage: 0, accountEquity: equity, P_MM_keff };

            return { leverage: exposure / denominator, accountEquity: equity, P_MM_keff };
        } catch (err) {
            console.error('Error calc leverage:', err);
            return { leverage: 0, accountEquity: 0, P_MM_keff: 0 };
        }
    }

    // =========================================================================
    // --- 2. TRADING METHODS ---
    // =========================================================================

    public async placeOrder(
        symbol: string,
        side: 'BUY' | 'SELL',
        qty: number,
        userId?: number,
        type: 'LIMIT' | 'MARKET' = 'LIMIT',
        price?: number,
        slippage: number = CONFIG.DEFAULT_SLIPPAGE
    ): Promise<{ orderId: string, sentPrice: string, type: string }> {

        const ctx = await this.getContext(userId);

        if (!ctx.privateKey || !ctx.publicKey || !ctx.vaultId) {
            throw new Error('Extended keys not configured');
        }

        if (!symbol.includes('-USD')) symbol = `${symbol}-USD`;

        console.log(`\n🚀 ${type} ${side} ${symbol} | Qty: ${qty} ${type === 'LIMIT' ? '| Price: ' + price : ''} (User: ${userId})`);

        // <--- ВАЖНО: Добавлен timeout в инстанс. Это защитит все 5 запросов внутри этого метода.
        const api = axios.create({
            baseURL: this.apiUrl,
            headers: { 'X-Api-Key': ctx.apiKey, 'Content-Type': 'application/json' },
            timeout: CONFIG.HTTP_TIMEOUT
        });

        try {
            // 1. Получаем данные (Рынок, Комиссии, Сеть, Стакан)
            const [marketInfoRes, feesDataRes, starknetDataRes, marketStatsRes] = await Promise.all([
                api.get(`/info/markets?market=${symbol}`),
                api.get(`/user/fees?market=${symbol}`),
                api.get('/info/starknet'),
                api.get(`/info/markets/${symbol}/stats`)
            ]);

            const marketData = marketInfoRes.data.data[0];
            const feesData = feesDataRes.data.data[0];
            const starknetData = starknetDataRes.data.data;
            const marketStats = marketStatsRes.data.data;

            if (!marketData) throw new Error(`Market ${symbol} not found`);

            // 2. Расчет цены и типа исполнения
            let finalPrice: string;
            let timeInForce: string;
            let postOnly: boolean;

            if (type === 'MARKET') {
                const isBuy = side === 'BUY';
                const basePrice = parseFloat(isBuy ? marketStats.askPrice : marketStats.bidPrice);
                const priceWithSlippage = basePrice * (isBuy ? (1 + slippage) : (1 - slippage));
                finalPrice = this.roundToStep(priceWithSlippage, marketData.tradingConfig.minPriceChange, isBuy ? 'ceil' : 'floor');

                timeInForce = 'IOC';
                postOnly = false;
                console.log(`💡 Market Price Calc: ${basePrice} -> ${finalPrice} (w/ slippage)`);
            } else {
                if (!price) throw new Error('Price is required for LIMIT orders');
                finalPrice = price.toString();
                timeInForce = 'GTT';
                postOnly = true;
            }

            // 3. Расчет комиссии
            const feeRate = Math.max(parseFloat(feesData.makerFeeRate), parseFloat(feesData.takerFeeRate)).toString();
            const myUuid = randomUUID();

            const orderPayload = {
                market: symbol,
                type,
                side,
                qty: qty.toString(),
                price: finalPrice,
                timeInForce,
                expiryEpochMillis: Date.now() + (CONFIG.EXPIRATION_HOURS * 3600 * 1000),
                fee: feeRate,
                nonce: Math.floor(Math.random() * (2 ** 31 - 1) + 1).toString(),
                postOnly: type === 'LIMIT',
                reduceOnly: false,
                id: myUuid
            };

            // 4. Подпись
            const settlement = this.signOrder(orderPayload, marketData, starknetData, ctx);

            // 5. Отправка
            const response = await api.post('/user/order', { ...orderPayload, settlement });

            if (response.data.status !== 'OK') {
                throw new Error(JSON.stringify(response.data));
            }

            console.log(`✅ Success! Order UUID: ${response.data.data.externalId}\n`);

            return {
                orderId: response.data.data.externalId,
                sentPrice: finalPrice,
                type: type
            };

        } catch (e: any) {
            if (e.response?.data?.error?.message === 'Invalid StarkEx signature') {
                console.log('\n❌ SIGNATURE ERROR Details:', e.response.data.error.debugInfo);
            }
            const errMsg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
            console.error(`❌ Error placing order: ${errMsg}`);
            throw new Error(errMsg);
        }
    }

    public async getOrderDetails(externalId: string, userId?: number): Promise<any> {
        try {
            const ctx = await this.getContext(userId);
            if (!ctx.apiKey) throw new Error('No Key');

            const response = await axios.get(`${this.apiUrl}/user/orders/external/${externalId}`, {
                headers: {
                    'X-Api-Key': ctx.apiKey,
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                timeout: CONFIG.HTTP_TIMEOUT // <--- Added Timeout
            });

            if (response.data.status === 'OK' && response.data.data) {
                return response.data.data;
            } else {
                throw new Error('Order not found or invalid status');
            }
        } catch (error: any) {
            const msg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
            console.error(`❌ Failed to fetch order details: ${msg}`);
            throw new Error(`GetOrder Error: ${msg}`);
        }
    }

    // =========================================================================
    // --- 3. HELPERS ---
    // =========================================================================

    private signOrder(order: any, marketInfo: any, network: any, ctx: ExtendedContext) {
        const isBuy = order.side === 'BUY';
        const amount = parseFloat(order.qty);
        const price = parseFloat(order.price);
        const totalValue = amount * price;
        const feeRate = parseFloat(order.fee);

        const resSynthetic = BigInt(marketInfo.l2Config.syntheticResolution);
        const resCollateral = BigInt(marketInfo.l2Config.collateralResolution);

        const amountStark = BigInt(Math.round(amount * Number(resSynthetic)));
        const collateralStark = BigInt(Math.round(totalValue * Number(resCollateral)));
        const feeStark = BigInt(Math.ceil(Number((totalValue * feeRate * Number(resCollateral)).toFixed(6))));

        const baseAmount = isBuy ? amountStark : -amountStark;
        const quoteAmount = isBuy ? -collateralStark : collateralStark;

        const expiration = Math.ceil(order.expiryEpochMillis / 1000) + (14 * 86400);

        const domainHash = poseidonHashMany([
            BigInt('0x1ff2f602e42168014d405a94f75e8a93d640751d71d16311266e140d8b0a210'),
            this.stringToFelt(network.name),
            this.stringToFelt(network.version),
            this.stringToFelt(network.chainId),
            BigInt(network.revision)
        ]);

        const orderHash = poseidonHashMany([
            BigInt('0x36da8d51815527cabfaa9c982f564c80fa7429616739306036f1f9b608dd112'),
            BigInt(ctx.vaultId),
            BigInt(marketInfo.l2Config.syntheticId),
            baseAmount,
            BigInt(marketInfo.l2Config.collateralId),
            quoteAmount,
            BigInt(marketInfo.l2Config.collateralId),
            feeStark,
            BigInt(expiration),
            BigInt(order.nonce)
        ]);

        const msgHash = poseidonHashMany([
            BigInt(shortString.encodeShortString("StarkNet Message")),
            domainHash,
            BigInt(ctx.publicKey),
            orderHash
        ]);

        const signature = ec.starkCurve.sign(num.toHex(msgHash), ctx.privateKey);

        return {
            signature: { r: num.toHex(signature.r), s: num.toHex(signature.s) },
            starkKey: ctx.publicKey,
            collateralPosition: ctx.vaultId
        };
    }

    private stringToFelt(str: string): bigint {
        return BigInt(shortString.encodeShortString(str));
    }

    private roundToStep(value: number, stepStr: string, mode: 'floor' | 'ceil' = 'floor'): string {
        const step = parseFloat(stepStr);
        const precision = stepStr.split('.')[1]?.length || 0;

        let rounded: number;
        if (mode === 'ceil') {
            rounded = Math.ceil(value / step) * step;
        } else {
            rounded = Math.floor(value / step) * step;
        }

        return rounded.toFixed(precision);
    }
    // Быстрый метод для Auto-Close
    public async getSimplePositions(userId?: number): Promise<IDetailedPosition[]> {
        try {
            const ctx = await this.getContext(userId);
            if (!ctx.apiKey) return [];

            const positionsResponse = await this.getUserPositions(ctx);
            if (positionsResponse.status !== 'OK' || !Array.isArray(positionsResponse.data)) {
                return [];
            }

            return positionsResponse.data
                .filter(p => p.status === 'OPENED')
                .map(position => ({
                    coin: position.market.replace(/-USD$/, ''),
                    notional: '0',
                    size: Math.abs(parseFloat(position.size)),
                    side: position.side === 'LONG' ? 'L' : 'S',
                    exchange: 'E',
                    fundingRate: 0,
                    entryPrice: 0
                }));
        } catch (err) {
            console.error('[Extended] Simple positions error:', err);
            return [];
        }
    }
}
