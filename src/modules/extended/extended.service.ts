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

// Настройки
const CONFIG = {
    DEFAULT_SLIPPAGE: 0.0075, // 0.75%
    EXPIRATION_HOURS: 1
};

export class ExtendedService {
    private readonly isTestnet: boolean;
    private readonly apiUrl: string;

    private readonly apiKey: string;
    private readonly privateKey: string;
    private readonly publicKey: string;
    private readonly vaultId: string;

    constructor() {
        this.isTestnet = process.env.TESTNET === 'true';

        this.apiUrl = this.isTestnet
            ? 'https://api.starknet.sepolia.extended.exchange/api/v1' // Testnet
            : 'https://api.starknet.extended.exchange/api/v1';         // Mainnet

        console.log(`${this.isTestnet ? '🟡' : '🟢'} [Extended] Service initialized.`);

        if (this.isTestnet) {
            this.apiKey = process.env.EXTENDED_API_KEY_TEST || '';
            this.privateKey = process.env.EXTENDED_STARK_KEY_PRIVATE_TEST || '';
            this.publicKey = process.env.EXTENDED_STARK_KEY_PUBLIC_TEST || '';
            this.vaultId = process.env.EXTENDED_VAULTID_TEST || '';
        } else {
            this.apiKey = process.env.EXTENDED_API_KEY || '';
            this.privateKey = process.env.EXTENDED_STARK_KEY_PRIVATE || '';
            this.publicKey = process.env.EXTENDED_STARK_KEY_PUBLIC || '';
            this.vaultId = process.env.EXTENDED_VAULTID || '';
        }

        if (!this.apiKey) {
            throw new Error(`Extended API Key is missing for ${this.isTestnet ? 'TESTNET' : 'MAINNET'}`);
        }
    }

    private getErrorMessage(error: unknown): string {
        if (axios.isAxiosError(error)) {
            return JSON.stringify(error.response?.data) || error.message;
        }
        if (error instanceof Error) return error.message;
        return String(error);
    }

    // =========================================================================
    // --- 1. OLD DATA FETCHING METHODS (Сохраненные старые методы) ---
    // =========================================================================

    private async getAccountBalance(): Promise<IExtendedApiResponse> {
        try {
            const response = await axios.get(`${this.apiUrl}/user/balance`, {
                headers: { 'X-Api-Key': this.apiKey, 'Content-Type': 'application/json' },
            });
            return response.data;
        } catch (error) {
            throw new Error(`Failed to fetch balance: ${this.getErrorMessage(error)}`);
        }
    }

    private async getUserPositions(): Promise<IExtendedPositionsResponse> {
        try {
            const response = await axios.get(`${this.apiUrl}/user/positions`, {
                headers: { 'X-Api-Key': this.apiKey, 'Content-Type': 'application/json' },
            });
            return response.data;
        } catch (error) {
            throw new Error(`Failed to fetch positions: ${this.getErrorMessage(error)}`);
        }
    }

    public async getDetailedPositions(): Promise<IDetailedPosition[]> {
        try {
            const positionsResponse = await this.getUserPositions();
            if (positionsResponse.status !== 'OK' || !Array.isArray(positionsResponse.data)) {
                if (positionsResponse.status === 'OK') return [];
                throw new Error('Invalid positions data');
            }

            const openPositions = positionsResponse.data.filter(p => p.status === 'OPENED');

            const detailedPositionsPromises = openPositions.map(async (position): Promise<IDetailedPosition> => {
                const market = position.market;
                const statsResponse = await axios.get<IExtendedMarketStatsResponse>(`${this.apiUrl}/info/markets/${market}/stats`);
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
            });
            return Promise.all(detailedPositionsPromises);
        } catch (err) {
            console.error('Error fetching Extended positions:', err);
            return [];
        }
    }

    public async getOpenPosition(symbol: string): Promise<IDetailedPosition | undefined> {
        const cleanSymbol = symbol.replace('-USD', '');
        const allPositions = await this.getDetailedPositions();
        return allPositions.find(p => p.coin === cleanSymbol);
    }

    public async calculateLeverage(): Promise<IExchangeData> {
        try {
            const response = await this.getAccountBalance();
            const data = response?.data;
            if (!data) return { leverage: 0, accountEquity: 0 };

            const exposure = parseFloat(data.exposure || '0');
            const equity = parseFloat(data.equity || '0');
            const initialMargin = parseFloat(data.initialMargin || '0');

            if (exposure === 0 || equity === 0) return { leverage: 0, accountEquity: equity };

            const denominator = equity - (initialMargin / 2);
            if (denominator <= 0) return { leverage: 0, accountEquity: equity };

            return { leverage: exposure / denominator, accountEquity: equity };
        } catch (err) {
            console.error('Error calc leverage:', err);
            return { leverage: 0, accountEquity: 0 };
        }
    }

    // =========================================================================
    // --- 2. TRADING METHODS (UPDATED) ---
    // =========================================================================

    /**
     * Размещает ордер (MARKET или LIMIT).
     * Для MARKET цена рассчитывается автоматически на основе стакана + slippage.
     */
    public async placeOrder(
        symbol: string,
        side: 'BUY' | 'SELL',
        qty: number,
        type: 'LIMIT' | 'MARKET' = 'LIMIT',
        price?: number,
        slippage: number = CONFIG.DEFAULT_SLIPPAGE
    ): Promise<{ orderId: string, sentPrice: string, type: string }> {

        if (!this.privateKey || !this.publicKey || !this.vaultId) {
            throw new Error('Extended keys not configured');
        }

        if (!symbol.includes('-USD')) symbol = `${symbol}-USD`;

        console.log(`\n🚀 ${type} ${side} ${symbol} | Qty: ${qty} ${type === 'LIMIT' ? '| Price: ' + price : ''}`);

        const api = axios.create({
            baseURL: this.apiUrl,
            headers: { 'X-Api-Key': this.apiKey, 'Content-Type': 'application/json' }
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
                // BUY -> Ask, SELL -> Bid
                const basePrice = parseFloat(isBuy ? marketStats.askPrice : marketStats.bidPrice);

                // Применяем проскальзывание
                const priceWithSlippage = basePrice * (isBuy ? (1 + slippage) : (1 - slippage));

                // Округляем цену согласно шагу (minPriceChange)
                // BUY -> ВВЕРХ (ceil), SELL -> ВНИЗ (floor), чтобы ордер точно исполнился
                finalPrice = this.roundToStep(priceWithSlippage, marketData.tradingConfig.minPriceChange, isBuy ? 'ceil' : 'floor');

                timeInForce = 'IOC'; // Immediate or Cancel (для маркета)
                postOnly = false;
                console.log(`💡 Market Price Calc: ${basePrice} -> ${finalPrice} (w/ slippage)`);
            } else {
                // LIMIT
                if (!price) throw new Error('Price is required for LIMIT orders');
                finalPrice = price.toString();
                timeInForce = 'GTT'; // Good Till Time
                postOnly = true;     // Обычно Лимитки = PostOnly
            }

            // 3. Расчет комиссии
            const feeRate = Math.max(parseFloat(feesData.makerFeeRate), parseFloat(feesData.takerFeeRate)).toString();
            const myUuid = randomUUID(); // Наш external ID

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

            // 4. Подпись (StarkEx logic)
            const settlement = this.signOrder(orderPayload, marketData, starknetData);

            // 5. Отправка
            const response = await api.post('/user/order', { ...orderPayload, settlement });

            if (response.data.status !== 'OK') {
                throw new Error(JSON.stringify(response.data));
            }

            console.log(`✅ Success! Order UUID: ${response.data.data.externalId}\n`);

            return {
                orderId: response.data.data.externalId, // Возвращаем UUID                
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

    /**
     * Получение деталей ордера по External ID (UUID).
     * Используется для получения реальной цены исполнения MARKET ордера.
     */
    public async getOrderDetails(externalId: string): Promise<any> {
        try {
            // Эмуляция браузера + обязательный API Key
            const response = await axios.get(`${this.apiUrl}/user/orders/external/${externalId}`, {
                headers: {
                    'X-Api-Key': this.apiKey,
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
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
    // --- 3. HELPERS (Signature, Rounding, Parsing) ---
    // =========================================================================

    /**
     * Логика подписи ордера.
     * Полностью повторяет рабочий JS-скрипт (starknet logic).
     */
    private signOrder(order: any, marketInfo: any, network: any) {
        const isBuy = order.side === 'BUY';
        const amount = parseFloat(order.qty);
        const price = parseFloat(order.price);
        const totalValue = amount * price;
        const feeRate = parseFloat(order.fee);

        // Resolutions
        const resSynthetic = BigInt(marketInfo.l2Config.syntheticResolution);
        const resCollateral = BigInt(marketInfo.l2Config.collateralResolution);

        // Rounding (Math.round как в эталонном скрипте)
        const amountStark = BigInt(Math.round(amount * Number(resSynthetic)));
        const collateralStark = BigInt(Math.round(totalValue * Number(resCollateral)));

        // Fee: всегда округляем ВВЕРХ (Ceil)
        const feeStark = BigInt(Math.ceil(Number((totalValue * feeRate * Number(resCollateral)).toFixed(6))));

        // Знаки: BUY -> (+Syn, -Col), SELL -> (-Syn, +Col)
        // poseidonHashMany библиотеки @scure/starknet корректно хеширует отрицательные BigInt
        const baseAmount = isBuy ? amountStark : -amountStark;
        const quoteAmount = isBuy ? -collateralStark : collateralStark;

        const expiration = Math.ceil(order.expiryEpochMillis / 1000) + (14 * 86400); // +14 days

        // 1. Domain Hash
        const domainHash = poseidonHashMany([
            BigInt('0x1ff2f602e42168014d405a94f75e8a93d640751d71d16311266e140d8b0a210'),
            this.stringToFelt(network.name),
            this.stringToFelt(network.version),
            this.stringToFelt(network.chainId),
            BigInt(network.revision)
        ]);

        // 2. Order Hash
        const orderHash = poseidonHashMany([
            BigInt('0x36da8d51815527cabfaa9c982f564c80fa7429616739306036f1f9b608dd112'), // Selector
            BigInt(this.vaultId),
            BigInt(marketInfo.l2Config.syntheticId),
            baseAmount,
            BigInt(marketInfo.l2Config.collateralId),
            quoteAmount,
            BigInt(marketInfo.l2Config.collateralId),
            feeStark,
            BigInt(expiration),
            BigInt(order.nonce)
        ]);

        // 3. Final Signature
        const msgHash = poseidonHashMany([
            BigInt(shortString.encodeShortString("StarkNet Message")),
            domainHash,
            BigInt(this.publicKey),
            orderHash
        ]);

        const signature = ec.starkCurve.sign(num.toHex(msgHash), this.privateKey);

        return {
            signature: { r: num.toHex(signature.r), s: num.toHex(signature.s) },
            starkKey: this.publicKey,
            collateralPosition: this.vaultId
        };
    }

    private stringToFelt(str: string): bigint {
        return BigInt(shortString.encodeShortString(str));
    }

    /**
     * Округляет число до заданного шага (step).
     * @param value Число
     * @param stepStr Шаг (например, "0.05")
     * @param mode 'floor' (вниз) или 'ceil' (вверх)
     */
    private roundToStep(value: number, stepStr: string, mode: 'floor' | 'ceil' = 'floor'): string {
        const step = parseFloat(stepStr);
        // Считаем кол-во знаков после запятой у шага
        const precision = stepStr.split('.')[1]?.length || 0;

        let rounded: number;
        if (mode === 'ceil') {
            rounded = Math.ceil(value / step) * step;
        } else {
            rounded = Math.floor(value / step) * step;
        }

        return rounded.toFixed(precision);
    }


}