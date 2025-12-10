import axios, { AxiosRequestConfig } from 'axios';
import { ec, typedData as starkTypedData, shortString } from 'starknet';
import { getUnixTime } from 'date-fns';
import {
    IExchangeData,
    IDetailedPosition,
    IParadexAccountResponse,
    IParadexPosition,
    IAuthRequest,
    IParadexPositionsResponse
} from '../../common/interfaces';

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
    // АВТОРИЗАЦИЯ (CORE)
    // =================================================================

    /**
     * Получает точное время с сервера Paradex.
     * Это предотвращает ошибки "token expired" или "token used before issued".
     */
    private async getServerTime(): Promise<number> {
        try {
            // Запрашиваем время у биржи
            const response = await axios.get(`${this.apiUrl}/system/time`);

            // Paradex обычно возвращает server_time в микросекундах (16 цифр)
            // Нам нужны секунды для JWT
            const serverTimeMicro = parseInt(response.data.server_time || response.data.time);

            // Конвертируем в секунды (Unix timestamp)
            const serverTimeSeconds = Math.floor(serverTimeMicro / 1000);

            return serverTimeSeconds;
        } catch (error) {
            console.warn('[Paradex] Failed to fetch server time, falling back to local time.');
            // Fallback на локальное время, если эндпоинт времени недоступен
            return getUnixTime(new Date());
        }
    }

    private async getJwtToken(): Promise<string> {
        // Если токен есть и он свежий - возвращаем его
        if (this.jwtToken && this.tokenExpiration > Date.now()) {
            return this.jwtToken;
        }

        try {
            //console.log('[Paradex] Authenticating...');

            // 1. ПОЛУЧАЕМ ВРЕМЯ СЕРВЕРА (Синхронизация)
            const timestamp = await this.getServerTime();

            // Expiration ставим +7 дней от времени сервера
            const expiration = timestamp + (6 * 24 * 60 * 60);

            const request: IAuthRequest = {
                method: "POST",
                path: "/v1/auth",
                body: "", // Важно: пустая строка
                timestamp,
                expiration
            };

            const typedData = {
                domain: { name: "Paradex", chainId: this.chainId, version: "1" },
                primaryType: "Request",
                types: {
                    StarkNetDomain: [
                        { name: "name", type: "felt" }, { name: "chainId", type: "felt" }, { name: "version", type: "felt" }
                    ],
                    Request: [
                        { name: "method", type: "felt" }, { name: "path", type: "felt" }, { name: "body", type: "felt" },
                        { name: "timestamp", type: "felt" }, { name: "expiration", type: "felt" }
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

            // Отправляем пустую строку как body
            const response = await axios.post(`${this.apiUrl}/auth`, "", { headers });

            if (!response.data || !response.data.jwt_token) {
                throw new Error('No jwt_token in response');
            }

            this.jwtToken = response.data.jwt_token;
            // Обновляем локальное время истечения (с запасом 1 час)
            this.tokenExpiration = Date.now() + this.SEVEN_DAYS_MS - (3600 * 1000);

            //console.log('[Paradex] Authenticated successfully.');
            return this.jwtToken as string;

        } catch (error) {
            this.jwtToken = null;
            this.tokenExpiration = 0;
            throw new Error(`Failed to get JWT token: ${this.getErrorMessage(error)}`);
        }
    }

    /**
     * Обертка для запросов с автоматическим ретраем при 401
     * Решает проблему "протухшего" токена
     */
    private async requestWithRetry<T>(method: 'GET' | 'POST', endpoint: string, data?: any): Promise<T> {
        let token = await this.getJwtToken();

        const makeCall = async (t: string) => {
            const config: AxiosRequestConfig = {
                method,
                url: `${this.apiUrl}${endpoint}`,
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${t}`
                },
                data
            };
            return await axios(config);
        };

        try {
            const res = await makeCall(token);
            return res.data;
        } catch (error: any) {
            // Если ошибка 401 (Unauthorized) - пробуем обновить токен
            if (axios.isAxiosError(error) && error.response?.status === 401) {
                console.warn('[Paradex] 401 Unauthorized. Refreshing token...');

                // Сбрасываем кэш
                this.jwtToken = null;
                this.tokenExpiration = 0;

                // Получаем новый токен
                token = await this.getJwtToken();

                // Повторяем запрос
                const retryRes = await makeCall(token);
                return retryRes.data;
            }
            throw error;
        }
    }

    // =================================================================
    // ХЕЛПЕРЫ ДАННЫХ
    // =================================================================

    private async _getOpenPositions(): Promise<IParadexPosition[]> {
        // Используем requestWithRetry вместо прямого axios
        const data = await this.requestWithRetry<IParadexPositionsResponse>('GET', '/positions');
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
            const openPositions = await this._getOpenPositions();

            const detailed = await Promise.all(openPositions.map(async (pos) => {
                if (!pos.market) return null;
                try {
                    // Публичные эндпоинты можно дергать без токена
                    const [marketRes, summaryRes] = await Promise.all([
                        axios.get(`${this.apiUrl}/markets?market=${pos.market}`),
                        axios.get(`${this.apiUrl}/markets/summary?market=${pos.market}`)
                    ]);

                    const marketDetails = marketRes.data.results[0];
                    const marketSummary = summaryRes.data.results[0];

                    const size = Math.abs(parseFloat(pos.size || '0'));
                    const entryPrice = parseFloat(pos.average_entry_price_usd || '0');
                    const notional = this._calculatePositionNotional(pos);
                    console.log(entryPrice, notional)
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
            return [];
        }
    }

    public async calculateLeverage(): Promise<IExchangeData> {
        try {
            const [accountData, openPositions] = await Promise.all([
                this.requestWithRetry<IParadexAccountResponse>('GET', '/account'),
                this._getOpenPositions(),
            ]);

            if (typeof accountData?.account_value !== 'string' || typeof accountData?.maintenance_margin_requirement !== 'string') {
                return { leverage: 0, accountEquity: 0 };
            }

            const accountValue = parseFloat(accountData.account_value);
            const maintMargin = parseFloat(accountData.maintenance_margin_requirement);

            if (isNaN(accountValue) || isNaN(maintMargin)) return { leverage: 0, accountEquity: 0 };

            const totalNotional = openPositions.reduce((sum, p) => sum + this._calculatePositionNotional(p), 0);

            if (totalNotional === 0) return { leverage: 0, accountEquity: accountValue };

            const denominator = accountValue - maintMargin;
            if (denominator <= 0) return { leverage: 0, accountEquity: accountValue };

            const leverage = totalNotional / denominator;
            return { leverage, accountEquity: accountValue };

        } catch (err) {
            return { leverage: 0, accountEquity: 0 };
        }
    }

    public async getOpenPosition(symbol: string): Promise<IDetailedPosition | undefined> {
        const paradexSymbol = symbol.endsWith('-USD-PERP') ? symbol : `${symbol}-USD-PERP`;
        const positions = await this.getDetailedPositions();
        return positions.find(p =>
            p.coin === symbol ||
            p.coin === paradexSymbol.replace(/-USD-PERP$/, '') ||
            `${p.coin}-USD-PERP` === paradexSymbol
        );
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

            // Синхронизация времени для подписи ордера
            const timestamp = await this.getServerTime() * 1000; // API хочет мс, но синхронизированные

            // Если сервер возвращает мс, используем их. Если сек - умножаем.
            // getServerTime() у нас возвращает СЕКУНДЫ.
            // Paradex Order Signature хочет МИЛЛИСЕКУНДЫ.
            // Поэтому timestamp * 1000.

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

            // Отправляем через безопасную обертку
            const response: any = await this.requestWithRetry('POST', '/orders', payload);
            const orderId = response.id;

            // Поллинг статуса
            let attempts = 0;
            while (attempts < 20) {
                await new Promise(r => setTimeout(r, 500));

                const orderData: any = await this.requestWithRetry('GET', `/orders/${orderId}`);
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
            throw err;
        }
    }
}