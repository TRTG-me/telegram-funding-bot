// src/modules/paradex/paradex.service.ts

import axios from 'axios';
import { ec, typedData as starkTypedData, TypedData, shortString } from 'starknet';
import { getUnixTime } from 'date-fns';
import {
    IExchangeData,
    IDetailedPosition,
    IParadexAccountResponse,
    IParadexPosition,
    IAuthRequest,
    IParadexPositionsResponse
} from '../../common/interfaces';

type UnixTime = number;

export class ParadexService {
    // --- КОНФИГУРАЦИЯ ---
    private readonly isTestnet: boolean;
    private readonly apiUrl: string;
    private readonly chainId: string;

    // --- КЛЮЧИ ---
    private readonly accountAddress: string;
    private readonly privateKey: string;

    // --- АВТОРИЗАЦИЯ ---
    private readonly SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    private jwtToken: string | null = null;
    private tokenExpiration: number = 0;

    constructor() {
        this.isTestnet = process.env.TESTNET === 'true';

        if (this.isTestnet) {
            console.log('🟡 [Paradex] Initializing in TESTNET mode');
            this.apiUrl = 'https://api.testnet.paradex.trade/v1';
            this.chainId = shortString.encodeShortString("PRIVATE_SN_POTC_SEPOLIA");

            this.accountAddress = process.env.PARADEX_TESTNET_ACCOUNT_ADDRESS || '';
            this.privateKey = process.env.PARADEX_TESTNET_PRIVATE_KEY || '';
        } else {
            console.log('🟢 [Paradex] Initializing in MAINNET mode');
            this.apiUrl = 'https://api.prod.paradex.trade/v1';
            this.chainId = shortString.encodeShortString("PRIVATE_SN_PARACLEAR_MAINNET");

            this.accountAddress = process.env.PARADEX_ACCOUNT_ADDRESS || process.env.ACCOUNT_ADDRESS || '';
            this.privateKey = process.env.PARADEX_ACCOUNT_PRIVATE_KEY || process.env.ACCOUNT_PRIVATE_KEY || '';
        }

        if (!this.accountAddress || !this.privateKey) {
            throw new Error(`Paradex Address/Key missing for ${this.isTestnet ? 'TESTNET' : 'MAINNET'}`);
        }
    }

    private getErrorMessage(error: unknown): string {
        if (axios.isAxiosError(error)) {
            return JSON.stringify(error.response?.data) || error.message;
        }
        if (error instanceof Error) return error.message;
        return String(error);
    }

    // =================================================================
    // АВТОРИЗАЦИЯ
    // =================================================================

    private async getJwtToken(): Promise<string> {
        if (this.jwtToken && this.tokenExpiration > Date.now()) {
            return this.jwtToken;
        }

        try {
            const now = new Date();
            const timestamp = getUnixTime(now);
            const expiration = getUnixTime(new Date(now.getTime() + this.SEVEN_DAYS_MS));

            const request: IAuthRequest = {
                method: "POST",
                path: "/v1/auth",
                body: "",
                timestamp,
                expiration
            };

            const typedData = {
                domain: { name: "Paradex", chainId: this.chainId, version: "1" },
                primaryType: "Request",
                types: {
                    StarkNetDomain: [
                        { name: "name", type: "felt" },
                        { name: "chainId", type: "felt" },
                        { name: "version", type: "felt" }
                    ],
                    Request: [
                        { name: "method", type: "felt" },
                        { name: "path", type: "felt" },
                        { name: "body", type: "felt" },
                        { name: "timestamp", type: "felt" },
                        { name: "expiration", type: "felt" }
                    ]
                },
                message: request,
            };

            const msgHash = starkTypedData.getMessageHash(typedData, this.accountAddress);
            const { r, s } = ec.starkCurve.sign(msgHash, this.privateKey);
            const signature = JSON.stringify([r.toString(), s.toString()]);

            const headers = {
                'Accept': 'application/json',
                'PARADEX-STARKNET-ACCOUNT': this.accountAddress,
                'PARADEX-STARKNET-SIGNATURE': signature,
                'PARADEX-TIMESTAMP': timestamp.toString(),
                'PARADEX-SIGNATURE-EXPIRATION': expiration.toString()
            };

            const response = await axios.post(`${this.apiUrl}/auth`, {}, { headers });

            this.jwtToken = response.data.jwt_token;
            this.tokenExpiration = Date.now() + this.SEVEN_DAYS_MS - (60 * 60 * 1000);

            return this.jwtToken!;
        } catch (error) {
            this.jwtToken = null;
            throw new Error(`Failed to get JWT token: ${this.getErrorMessage(error)}`);
        }
    }

    // =================================================================
    // ХЕЛПЕРЫ ДАННЫХ
    // =================================================================

    private async getAccount(jwtToken: string): Promise<IParadexAccountResponse> {
        const headers = { 'Accept': 'application/json', 'Authorization': `Bearer ${jwtToken}` };
        const response = await axios.get(`${this.apiUrl}/account`, { headers });
        return response.data;
    }

    private async _getOpenPositions(jwtToken: string): Promise<IParadexPosition[]> {
        const headers = { 'Accept': 'application/json', 'Authorization': `Bearer ${jwtToken}` };
        const response = await axios.get(`${this.apiUrl}/positions`, { headers });
        const data = response.data as IParadexPositionsResponse;
        if (!Array.isArray(data?.results)) return [];
        return data.results.filter(p => p.status === 'OPEN');
    }

    private _calculatePositionNotional(position: IParadexPosition): number {
        const Cost = parseFloat(position.cost_usd || '0');
        const unrealizedPnl = parseFloat(position.unrealized_pnl || '0');
        const unrealizedFundingPnl = parseFloat(position.unrealized_funding_pnl || '0');
        return Math.abs(Cost + unrealizedPnl - unrealizedFundingPnl);
    }

    // =================================================================
    // ПУБЛИЧНЫЕ МЕТОДЫ (DATA)
    // =================================================================

    public async getDetailedPositions(): Promise<IDetailedPosition[]> {
        try {
            const token = await this.getJwtToken();
            const openPositions = await this._getOpenPositions(token);

            const detailed = await Promise.all(openPositions.map(async (pos) => {
                if (!pos.market) return null;
                try {
                    const [marketRes, summaryRes] = await Promise.all([
                        axios.get(`${this.apiUrl}/markets?market=${pos.market}`),
                        axios.get(`${this.apiUrl}/markets/summary?market=${pos.market}`)
                    ]);

                    const marketDetails = marketRes.data.results[0];
                    const marketSummary = summaryRes.data.results[0];

                    const size = Math.abs(parseFloat(pos.size || '0'));
                    const entryPrice = parseFloat(pos.average_entry_price || '0');
                    const notional = this._calculatePositionNotional(pos);

                    let fundingRate = parseFloat(marketSummary.funding_rate || '0');
                    if (marketDetails?.funding_period_hours) {
                        fundingRate = (fundingRate / marketDetails.funding_period_hours) * 8;
                    }

                    return {
                        coin: pos.market.replace(/-USD-PERP$/, ''),
                        notional: notional.toString(),
                        size: size,
                        side: pos.side === 'LONG' ? 'L' : 'S',
                        exchange: 'P',
                        fundingRate: fundingRate * 100,
                        entryPrice: entryPrice
                    } as IDetailedPosition;

                } catch (e) {
                    console.error(`Error processing Paradex pos ${pos.market}`, e);
                    return null;
                }
            }));

            return detailed.filter((p): p is IDetailedPosition => p !== null);

        } catch (err) {
            console.error('Error fetching Paradex positions:', err);
            throw new Error(`Paradex Positions Failed: ${this.getErrorMessage(err)}`);
        }
    }

    public async calculateLeverage(): Promise<IExchangeData> {
        try {
            const jwtToken = await this.getJwtToken();

            const [accountData, openPositions] = await Promise.all([
                this.getAccount(jwtToken),
                this._getOpenPositions(jwtToken),
            ]);

            if (typeof accountData?.account_value !== 'string' || typeof accountData?.maintenance_margin_requirement !== 'string') {
                throw new Error('Incomplete account data received from Paradex API.');
            }

            const accountValue = parseFloat(accountData.account_value);
            const maintMargin = parseFloat(accountData.maintenance_margin_requirement);

            if (isNaN(accountValue) || isNaN(maintMargin)) {
                throw new Error('Failed to parse financial data from Paradex API response.');
            }

            const totalNotional = openPositions.reduce((sum, p) => sum + this._calculatePositionNotional(p), 0);

            if (totalNotional === 0) {
                return { leverage: 0, accountEquity: accountValue };
            }

            const denominator = accountValue - maintMargin;
            if (denominator === 0) {
                // Если маржа равна эквити, но есть позы - это риск ликвидации, но математически деление на 0
                return { leverage: 0, accountEquity: accountValue };
            }

            const leverage = totalNotional / denominator;
            if (!isFinite(leverage)) {
                throw new Error('Leverage calculation resulted in a non-finite number.');
            }

            return { leverage, accountEquity: accountValue };

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error during Paradex leverage calculation:', err);
            throw new Error(`Failed to calculate Paradex leverage: ${message}`);
        }
    }

    public async getOpenPosition(symbol: string): Promise<IDetailedPosition | undefined> {
        const paradexSymbol = symbol.endsWith('-USD-PERP') ? symbol : `${symbol}-USD-PERP`;
        const positions = await this.getDetailedPositions();
        return positions.find(p => p.coin === symbol || p.coin === paradexSymbol || `${p.coin}-USD-PERP` === paradexSymbol);
    }

    // =================================================================
    // ТОРГОВЛЯ
    // =================================================================

    private toQuantums(amount: number): string {
        return (BigInt(Math.floor(amount * 100000000))).toString();
    }

    public async placeMarketOrder(
        symbol: string,
        side: 'BUY' | 'SELL',
        quantity: number
    ): Promise<any> {
        try {
            console.log(`[Paradex ${this.isTestnet ? 'TEST' : 'PROD'}] Placing MARKET ${side} ${quantity} ${symbol}`);

            const token = await this.getJwtToken();
            const timestamp = Date.now();
            const sizeQuantums = this.toQuantums(quantity);
            const sideFlag = side === 'BUY' ? '1' : '2';

            const messageToSign = {
                timestamp: timestamp,
                market: shortString.encodeShortString(symbol),
                side: sideFlag,
                orderType: shortString.encodeShortString('MARKET'),
                size: sizeQuantums,
                price: '0'
            };

            const typedData = {
                domain: { name: "Paradex", chainId: this.chainId, version: "1" },
                primaryType: "Order",
                types: {
                    StarkNetDomain: [
                        { name: "name", type: "felt" }, { name: "chainId", type: "felt" }, { name: "version", type: "felt" }
                    ],
                    Order: [
                        { name: "timestamp", type: "felt" }, { name: "market", type: "felt" }, { name: "side", type: "felt" },
                        { name: "orderType", type: "felt" }, { name: "size", type: "felt" }, { name: "price", type: "felt" },
                    ]
                },
                message: messageToSign
            };

            const msgHash = starkTypedData.getMessageHash(typedData, this.accountAddress);
            const { r, s } = ec.starkCurve.sign(msgHash, this.privateKey);
            const signature = JSON.stringify([r.toString(), s.toString()]);

            const payload = {
                market: symbol,
                side: side,
                type: 'MARKET',
                size: quantity.toString(),
                signature: signature,
                signature_timestamp: timestamp
            };

            const response = await axios.post(`${this.apiUrl}/orders`, payload, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            const orderId = response.data.id;

            // Поллинг
            let attempts = 0;
            while (attempts < 20) {
                await new Promise(r => setTimeout(r, 500));

                const orderData = await this.getOrder(orderId, token);
                const status = orderData.status;

                if (status === 'CLOSED') {
                    if (orderData.cancel_reason && orderData.cancel_reason !== 'NO_ERROR') {
                        throw new Error(`Paradex Rejected: ${orderData.cancel_reason}`);
                    }
                    if (parseFloat(orderData.size) === parseFloat(orderData.remaining_size)) {
                        throw new Error(`Paradex Rejected: No fill`);
                    }

                    const avgPrice = parseFloat(orderData.avg_fill_price || '0');
                    if (avgPrice === 0) throw new Error('Price is 0');

                    console.log(`[Paradex] Filled at ${avgPrice}`);
                    return {
                        id: orderId,
                        status: 'FILLED',
                        price: avgPrice,
                        executedQty: parseFloat(orderData.size || '0')
                    };
                }

                if (status === 'REJECTED' || status === 'CANCELED') {
                    throw new Error(`Paradex Rejected: ${orderData.cancel_reason}`);
                }
                attempts++;
            }
            throw new Error('Paradex Order Timeout');

        } catch (err: any) {
            console.error('Paradex Trade Error:', err.message);
            if (axios.isAxiosError(err) && err.response?.data) {
                const msg = (err.response.data as any).message || JSON.stringify(err.response.data);
                throw new Error(`Paradex API Error: ${msg}`);
            }
            throw new Error(`${err.message}`);
        }
    }

    private async getOrder(orderId: string, token: string): Promise<any> {
        try {
            const res = await axios.get(`${this.apiUrl}/orders/${orderId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            return res.data;
        } catch (e) {
            console.error('Get Order Error:', e);
            return {};
        }
    }
}