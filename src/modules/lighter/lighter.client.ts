import axios from 'axios';
import * as adapter from './signer.adapter';

// Константа таймаута
const HTTP_TIMEOUT = 10000;

export interface LighterConfig {
    baseUrl: string;
    privateKey: string;
    apiKeyIndex: number;
    accountIndex: string | number;
    chainId?: number;
}

export enum ORDER_TYPE {
    LIMIT = 0,
    MARKET = 1
}

const TIME_IN_FORCE = {
    IOC: 0,
    GTC: 1
};

export class LighterClient {
    private baseUrl: string;
    private privateKey: string;
    private apiKeyIndex: number;
    private accountIndex: bigint;
    private chainId: number;

    public markets: Record<number, any> = {};
    private symbolToId: Map<string, number> = new Map();

    public isInitialized = false;

    constructor(config: LighterConfig) {
        if (!config.baseUrl || !config.privateKey) {
            throw new Error("Missing required config: baseUrl, privateKey");
        }
        this.baseUrl = config.baseUrl.replace(/\/$/, '');
        this.privateKey = config.privateKey;
        this.apiKeyIndex = Number(config.apiKeyIndex);
        this.accountIndex = BigInt(config.accountIndex);
        this.chainId = config.chainId || 300;
    }

    async init() {
        if (this.isInitialized) return;
        await this._loadMarkets();
        this._initSigner();
        this.isInitialized = true;
    }

    private async _loadMarkets() {
        try {
            const url = `${this.baseUrl}/api/v1/orderBooks`;
            // Добавлен таймаут
            const res = await axios.get(url, { timeout: HTTP_TIMEOUT });

            const list = res.data?.order_books || [];

            if (list.length > 0) {
                let perpCount = 0;

                list.forEach((m: any) => {
                    if (m.market_type !== 'perp') {
                        return;
                    }

                    perpCount++;
                    const id = parseInt(m.market_id);

                    this.markets[id] = {
                        id: id,
                        symbol: m.symbol,
                        sizeDecimals: m.supported_size_decimals,
                        priceDecimals: m.supported_price_decimals,
                        minBaseAmount: parseFloat(m.min_base_amount),
                        minQuoteAmount: parseFloat(m.min_quote_amount)
                    };

                    const rawSymbol = m.symbol.toUpperCase();
                    this.symbolToId.set(rawSymbol, id);

                    if (rawSymbol.includes('-')) {
                        const cleanTicker = rawSymbol.split('-')[0];
                        this.symbolToId.set(cleanTicker, id);
                    }

                    if (rawSymbol.includes('/')) {
                        const cleanTicker = rawSymbol.split('/')[0];
                        this.symbolToId.set(cleanTicker, id);
                    }

                    if (rawSymbol.startsWith('WETH')) this.symbolToId.set('ETH', id);
                    if (rawSymbol.startsWith('WBTC')) this.symbolToId.set('BTC', id);
                });
            } else {
                console.warn('[LighterClient] No markets found in API response');
            }
        } catch (e: any) {
            console.warn('[LighterClient] Failed to load market info:', e.message);
        }
    }

    public getMarketId(coin: string): number | null {
        const ticker = coin.toUpperCase();
        if (this.symbolToId.has(ticker)) {
            return this.symbolToId.get(ticker)!;
        }
        return null;
    }

    private _initSigner() {
        const err = adapter.CreateClient(this.baseUrl, this.privateKey, this.chainId, this.apiKeyIndex, this.accountIndex);
        if (err) throw new Error(`Signer init failed: ${err}`);
    }

    async getNextNonce(): Promise<bigint> {
        const url = `${this.baseUrl}/api/v1/nextNonce?account_index=${this.accountIndex}&api_key_index=${this.apiKeyIndex}`;
        // Добавлен таймаут
        const res = await axios.get(url, { timeout: HTTP_TIMEOUT });
        return BigInt(res.data.nonce);
    }

    async getOrderBook(marketId: number) {
        const url = `${this.baseUrl}/api/v1/orderBookOrders?market_id=${marketId}&limit=50`;
        // Добавлен таймаут
        const res = await axios.get(url, { timeout: HTTP_TIMEOUT });
        if (!res.data) throw new Error(`OrderBook orders for market ${marketId} unavailable`);
        return res.data;
    }

    async getTransactionByHash(hash: string) {
        try {
            const cleanHash = hash.replace('0x', '');
            const url = `${this.baseUrl}/api/v1/tx?by=hash&value=${cleanHash}`;
            // Добавлен таймаут
            const res = await axios.get(url, { timeout: HTTP_TIMEOUT });
            return res.data;
        } catch (e: any) {
            if (e.response && e.response.status === 404) return null;
            return null;
        }
    }

    async placeOrder({ marketId, isAsk, orderType, amount, price, slippage = 0.05 }: {
        marketId: number, isAsk: boolean, orderType: ORDER_TYPE, amount: number, price?: number, slippage?: number
    }) {
        if (!this.isInitialized) await this.init();

        const market = this.markets[marketId];
        if (!market) throw new Error(`Market ID ${marketId} unknown (not found in init list).`);

        let finalPrice = price || 0;

        if (orderType === ORDER_TYPE.MARKET) {
            const ob = await this.getOrderBook(marketId);
            const side = isAsk ? ob.bids : ob.asks;
            if (!side || side.length === 0) throw new Error("OrderBook empty!");
            const topPrice = parseFloat(side[0].price);
            finalPrice = isAsk ? topPrice * (1 - slippage) : topPrice * (1 + slippage);
        }

        const sizeMult = 10 ** market.sizeDecimals;
        const priceMult = 10 ** market.priceDecimals;
        const rawBaseAmount = BigInt(Math.round(amount * sizeMult));
        const rawPrice = Math.round(finalPrice * priceMult);

        const nonce = await this.getNextNonce();
        const clientOrderIndex = BigInt(Date.now());

        let timeInForce = TIME_IN_FORCE.GTC;
        let expiry = BigInt(Date.now() + 24 * 3600 * 1000);

        if (orderType === ORDER_TYPE.MARKET) {
            timeInForce = TIME_IN_FORCE.IOC;
            expiry = 0n;
        }

        const isAskInt = isAsk ? 1 : 0;

        const signedTx = adapter.SignCreateOrder(
            marketId, clientOrderIndex, rawBaseAmount, rawPrice, isAskInt, orderType, timeInForce, 0, 0, expiry, nonce, this.apiKeyIndex, this.accountIndex
        );

        if (signedTx.err) throw new Error(`Signing error: ${signedTx.err}`);

        const sendUrl = `${this.baseUrl}/api/v1/sendTx`;
        const formData = new FormData();
        formData.append('tx_type', signedTx.txType.toString());
        formData.append('tx_info', signedTx.txInfo);
        formData.append('price_protection', 'false');

        // Добавлен таймаут
        const response = await axios.post(sendUrl, formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
            timeout: HTTP_TIMEOUT
        });

        return {
            apiResponse: response.data,
            sentNonce: nonce.toString(),
            txHash: signedTx.txHash,
            marketId
        };
    }
}