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
import { UserService } from '../users/users.service';

// --- КОНСТАНТЫ ---
const HTTP_TIMEOUT = 10000; // 10 секунд

// --- ЗАГОЛОВКИ БРАУЗЕРА (ОБЯЗАТЕЛЬНО) ---
const BROWSER_HEADERS = {
    'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    'Origin': 'https://app.paradex.trade',
    'Referer': 'https://app.paradex.trade/'
};

interface ParadexContext {
    accountAddress: string;
    privateKey: string;
    jwtToken: string | null;
    tokenExpiration: number;
}

export class ParadexService {
    // --- КОНФИГУРАЦИЯ ---
    private readonly isTestnet: boolean;
    private readonly apiUrl: string;
    private readonly chainId: string;
    private readonly TOKEN_LIFETIME_SECONDS = 300;

    // --- КЛЮЧИ ---
    // private defaultContext: ParadexContext; // Removed default context
    private userContexts = new Map<number, ParadexContext>();

    constructor(private userService: UserService) {
        this.isTestnet = process.env.TESTNET === 'true';

        if (this.isTestnet) {
            console.log('🟡 [Paradex] Initializing in TESTNET mode');
            this.apiUrl = 'https://api.testnet.paradex.trade/v1';
            this.chainId = shortString.encodeShortString("PRIVATE_SN_POTC_SEPOLIA");
        } else {
            console.log('🟢 [Paradex] Initializing in MAINNET mode');
            this.apiUrl = 'https://api.prod.paradex.trade/v1';
            this.chainId = shortString.encodeShortString("PRIVATE_SN_PARACLEAR_MAINNET");
        }
    }

    private createContext(address?: string, privateKey?: string): ParadexContext {
        return {
            accountAddress: address || '',
            privateKey: privateKey || '',
            jwtToken: null,
            tokenExpiration: 0
        };
    }

    private async getContext(userId?: number): Promise<ParadexContext> {
        if (!userId) {
            throw new Error('[Paradex] userId is required for all operations');
        }

        if (this.userContexts.has(userId)) return this.userContexts.get(userId)!;

        // Проверка наличия UserService
        if (!this.userService) {
            throw new Error('[Paradex] UserService not available');
        }

        const user = await this.userService.getUser(userId);
        if (!user) {
            throw new Error(`[Paradex] User ${userId} not found in database`);
        }

        const address = this.isTestnet ? user.paradexTestAccountAddress : user.paradexAccountAddress;
        const pKey = this.isTestnet ? user.paradexTestPrivateKey : user.paradexPrivateKey;

        // Строгая проверка: ключи ОБЯЗАТЕЛЬНЫ
        if (!address || !pKey) {
            throw new Error(`[Paradex] User ${userId} has no API keys configured for ${this.isTestnet ? 'Testnet' : 'Mainnet'}. Please add keys to database.`);
        }

        const ctx = this.createContext(address, pKey);
        this.userContexts.set(userId, ctx);
        return ctx;
    }

    private getErrorMessage(error: unknown): string {
        if (axios.isAxiosError(error)) {
            if (error.code === 'ECONNABORTED') return 'Network Timeout';
            return JSON.stringify(error.response?.data) || error.message;
        }
        if (error instanceof Error) return error.message;
        return String(error);
    }

    // =================================================================
    // АВТОРИЗАЦИЯ (CORE)
    // =================================================================

    private async getServerTime(): Promise<number> {
        try {
            const response = await axios.get(`${this.apiUrl}/system/time`, {
                headers: BROWSER_HEADERS,
                timeout: HTTP_TIMEOUT
            });
            const serverTimeMicro = parseInt(response.data.server_time || response.data.time);
            return Math.floor(serverTimeMicro / 1000);
        } catch (error) {
            console.warn('[Paradex] Failed to fetch server time, using local.');
            return getUnixTime(new Date());
        }
    }

    private async getJwtToken(ctx: ParadexContext): Promise<string> {
        if (ctx.jwtToken && ctx.tokenExpiration > Date.now() + 60000) {
            return ctx.jwtToken;
        }

        try {
            const timestamp = await this.getServerTime();
            const expiration = timestamp + this.TOKEN_LIFETIME_SECONDS;

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
                        { name: "name", type: "felt" }, { name: "chainId", type: "felt" }, { name: "version", type: "felt" }
                    ],
                    Request: [
                        { name: "method", type: "felt" }, { name: "path", type: "felt" }, { name: "body", type: "felt" },
                        { name: "timestamp", type: "felt" }, { name: "expiration", type: "felt" }
                    ]
                },
                message: request,
            };

            const msgHash = starkTypedData.getMessageHash(typedData, ctx.accountAddress);
            const { r, s } = ec.starkCurve.sign(msgHash, ctx.privateKey);
            const signature = JSON.stringify([r.toString(), s.toString()]);

            const headers = {
                ...BROWSER_HEADERS,
                'Accept': 'application/json',
                'PARADEX-STARKNET-ACCOUNT': ctx.accountAddress,
                'PARADEX-STARKNET-SIGNATURE': signature,
                'PARADEX-TIMESTAMP': timestamp.toString(),
                'PARADEX-SIGNATURE-EXPIRATION': expiration.toString(),
                'PARADEX-AUTHORIZE-ISOLATED-MARKETS': 'true'
            };

            const response = await axios.post(`${this.apiUrl}/auth?token_usage=interactive`, "", {
                headers,
                timeout: HTTP_TIMEOUT
            });

            if (!response.data || !response.data.jwt_token) {
                throw new Error('No jwt_token in response');
            }

            ctx.jwtToken = response.data.jwt_token;
            ctx.tokenExpiration = Date.now() + (this.TOKEN_LIFETIME_SECONDS * 1000);

            return ctx.jwtToken as string;

        } catch (error) {
            ctx.jwtToken = null;
            ctx.tokenExpiration = 0;
            throw new Error(`Failed to get JWT token: ${this.getErrorMessage(error)}`);
        }
    }

    private async requestWithRetry<T>(method: 'GET' | 'POST', endpoint: string, ctx: ParadexContext, data?: any): Promise<T> {
        let token = await this.getJwtToken(ctx);

        const makeCall = async (t: string) => {
            const config: AxiosRequestConfig = {
                method,
                url: `${this.apiUrl}${endpoint}`,
                headers: {
                    ...BROWSER_HEADERS,
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${t}`
                },
                data,
                timeout: HTTP_TIMEOUT
            };
            return await axios(config);
        };

        try {
            const res = await makeCall(token);
            return res.data;
        } catch (error: any) {
            // Если 401, пробуем обновить токен
            if (axios.isAxiosError(error) && error.response?.status === 401) {
                console.warn('[Paradex] 401 Unauthorized. Force refreshing token...');
                ctx.jwtToken = null;
                ctx.tokenExpiration = 0;
                token = await this.getJwtToken(ctx);
                const retryRes = await makeCall(token);
                return retryRes.data;
            }
            throw error;
        }
    }

    // =================================================================
    // МЕТОДЫ
    // =================================================================

    private async _getOpenPositions(ctx: ParadexContext): Promise<IParadexPosition[]> {
        const data = await this.requestWithRetry<IParadexPositionsResponse>('GET', '/positions', ctx);
        if (!Array.isArray(data?.results)) return [];
        return data.results.filter(p => p.status === 'OPEN');
    }

    private _calculatePositionNotional(position: IParadexPosition): number {
        const Cost = parseFloat(position.cost_usd || '0');
        const unrealizedPnl = parseFloat(position.unrealized_pnl || '0');
        const unrealizedFundingPnl = parseFloat(position.unrealized_funding_pnl || '0');
        return Math.abs(Cost + unrealizedPnl - unrealizedFundingPnl);
    }

    public async getDetailedPositions(userId?: number): Promise<IDetailedPosition[]> {
        try {
            const ctx = await this.getContext(userId);
            // Если ключей нет - выходим
            if (!ctx.accountAddress || !ctx.privateKey) return [];

            const openPositions = await this._getOpenPositions(ctx);
            const detailed = await Promise.all(openPositions.map(async (pos) => {
                if (!pos.market) return null;
                try {
                    // Добавляем Timeout в параллельные запросы инфо о рынке
                    const [marketRes, summaryRes] = await Promise.all([
                        axios.get(`${this.apiUrl}/markets?market=${pos.market}`, {
                            headers: BROWSER_HEADERS,
                            timeout: HTTP_TIMEOUT
                        }),
                        axios.get(`${this.apiUrl}/markets/summary?market=${pos.market}`, {
                            headers: BROWSER_HEADERS,
                            timeout: HTTP_TIMEOUT
                        })
                    ]);

                    const marketDetails = marketRes.data.results[0];
                    const marketSummary = summaryRes.data.results[0];

                    const size = Math.abs(parseFloat(pos.size || '0'));

                    let entryPrice = parseFloat(pos.average_entry_price_usd || '0');
                    if (entryPrice === 0 && pos.average_entry_price_usd) {
                        entryPrice = parseFloat(pos.average_entry_price_usd);
                    }

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

                } catch (e) { return null; }
            }));
            return detailed.filter((p): p is IDetailedPosition => p !== null);
        } catch (err) {
            return [];
        }
    }

    public async calculateLeverage(userId?: number): Promise<IExchangeData> {
        try {
            const ctx = await this.getContext(userId);
            if (!ctx.accountAddress || !ctx.privateKey) return { leverage: 0, accountEquity: 0, P_MM_keff: 0 };


            const [accountData, openPositions] = await Promise.all([
                this.requestWithRetry<IParadexAccountResponse>('GET', '/account', ctx),
                this._getOpenPositions(ctx),
            ]);

            if (typeof accountData?.account_value !== 'string') return { leverage: 0, accountEquity: 0, P_MM_keff: 0 };

            const accountValue = parseFloat(accountData.account_value);
            const maintMargin = parseFloat(accountData.maintenance_margin_requirement || '0');

            if (isNaN(accountValue)) return { leverage: 0, accountEquity: 0, P_MM_keff: 0 };

            const totalNotional = openPositions.reduce((sum, p) => sum + this._calculatePositionNotional(p), 0);

            const P_MM_keff = totalNotional ? (maintMargin / totalNotional) : 0;

            if (totalNotional === 0) return { leverage: 0, accountEquity: accountValue, P_MM_keff };

            const denominator = accountValue - maintMargin;
            if (denominator <= 0) return { leverage: 0, accountEquity: accountValue, P_MM_keff };

            const leverage = totalNotional / denominator;
            return { leverage, accountEquity: accountValue, P_MM_keff };

        } catch (err) {
            return { leverage: 0, accountEquity: 0, P_MM_keff: 0 };
        }
    }

    public async getOpenPosition(symbol: string, userId?: number): Promise<IDetailedPosition | undefined> {
        const paradexSymbol = symbol.endsWith('-USD-PERP') ? symbol : `${symbol}-USD-PERP`;
        const positions = await this.getDetailedPositions(userId);
        return positions.find(p =>
            p.coin === symbol ||
            p.coin === paradexSymbol.replace(/-USD-PERP$/, '') ||
            `${p.coin}-USD-PERP` === paradexSymbol
        );
    }

    // =================================================================
    // ТОРГОВЛЯ (UPDATED FOR RPI)
    // =================================================================


    private toQuantums(amount: number): string {
        // 9.7 -> "9.70000000" -> "970000000"
        return BigInt(amount.toFixed(8).replace('.', '')).toString();
    }

    public async placeMarketOrder(
        symbol: string,
        side: 'BUY' | 'SELL',
        quantity: number,
        userId?: number
    ): Promise<any> {
        try {
            const ctx = await this.getContext(userId);
            if (!ctx.accountAddress || !ctx.privateKey) throw new Error('No Paradex credentials');

            console.log(`[Paradex ${this.isTestnet ? 'TEST' : 'PROD'}] Placing RPI MARKET ${side} ${quantity} ${symbol} (User: ${userId})`);

            // 1. Получаем шаг размера ордера
            let stepSize = 0.1;
            try {
                const infoRes = await axios.get(`${this.apiUrl}/markets?market=${symbol}`, {
                    headers: BROWSER_HEADERS,
                    timeout: 5000
                });
                if (infoRes.data?.results?.[0]?.order_size_increment) {
                    stepSize = parseFloat(infoRes.data.results[0].order_size_increment);
                }
            } catch (e) {
                console.warn(`[Paradex] Failed to fetch step size for ${symbol}, using default ${stepSize}`);
            }

            // === 2. МАТЕМАТИКА (Integer Math) ===
            const MULTIPLIER = 100_000_000; // Точность 8 знаков

            // Переводим входные данные в целые числа (квантумы)
            const qtyQuantums = BigInt(Math.round(quantity * MULTIPLIER));
            const stepQuantums = BigInt(Math.round(stepSize * MULTIPLIER));

            if (stepQuantums === 0n) throw new Error('Invalid step size (0)');

            // Округляем количество вниз до ближайшего шага (в целых числах)
            const stepsCount = qtyQuantums / stepQuantums; // Деление BigInt отбрасывает остаток
            const finalQuantums = stepsCount * stepQuantums;

            // 1. Число для JSON (например 9.7)
            const safeQty = Number(finalQuantums) / MULTIPLIER;

            // 2. Строка для Подписи (например "970000000")
            const sizeForSign = finalQuantums.toString();

            if (safeQty <= 0) {
                throw new Error(`Quantity ${quantity} is too small for step size ${stepSize}`);
            }

            // === 3. ПОДГОТОВКА ДАННЫХ ===
            const timestampMs = Date.now(); // Миллисекунды
            const sideFlag = side === 'BUY' ? '1' : '2';

            console.log(`[Paradex Debug] In: ${quantity} | Step: ${stepSize} | Safe: ${safeQty} | Sign: ${sizeForSign}`);

            const messageToSign = {
                timestamp: timestampMs,
                market: shortString.encodeShortString(symbol),
                side: sideFlag,
                orderType: shortString.encodeShortString('MARKET'),
                size: sizeForSign, // Используем вычисленные квантумы
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

            const msgHash = starkTypedData.getMessageHash(typedData, ctx.accountAddress);
            const { r, s } = ec.starkCurve.sign(msgHash, ctx.privateKey);
            const signature = JSON.stringify([r.toString(), s.toString()]);

            // === 4. ОТПРАВКА ===
            const payload = {
                market: symbol,
                side: side,
                type: 'MARKET',
                size: safeQty.toString(), // Отправляем число 9.7 (API поймет)
                signature: signature,
                signature_timestamp: timestampMs,
                instruction: 'IOC'
            };

            const response: any = await this.requestWithRetry('POST', '/orders', ctx, payload);
            const orderId = response.id;

            // === 5. POLLING ===
            let attempts = 0;
            while (attempts < 20) {
                await new Promise(r => setTimeout(r, 500));
                const orderData: any = await this.requestWithRetry('GET', `/orders/${orderId}`, ctx);
                const status = orderData.status;

                if (status === 'CLOSED') {
                    if (orderData.cancel_reason && orderData.cancel_reason !== 'NO_ERROR') {
                        throw new Error(`Paradex Rejected: ${orderData.cancel_reason}`);
                    }
                    const avgPrice = parseFloat(orderData.avg_fill_price || '0');
                    console.log(`[Paradex] Filled ${safeQty} @ ${avgPrice}`);
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
            if (axios.isAxiosError(err) && err.response) {
                console.error('🔥 Paradex API Error Detail:', JSON.stringify(err.response.data, null, 2));
            } else {
                console.error('Paradex Trade Error:', err.message);
            }
            throw err;
        }
    }
    // Быстрый метод для Auto-Close
    public async getSimplePositions(userId?: number): Promise<IDetailedPosition[]> {
        try {
            const ctx = await this.getContext(userId);
            if (!ctx.accountAddress || !ctx.privateKey) return [];

            // Только 1 запрос!
            const openPositions = await this._getOpenPositions(ctx);

            return openPositions.map(pos => {
                if (!pos.market) return null;
                const size = Math.abs(parseFloat(pos.size || '0'));
                return {
                    coin: pos.market.replace(/-USD-PERP$/, ''),
                    notional: '0',
                    size: size,
                    side: pos.side === 'LONG' ? 'L' : 'S',
                    exchange: 'P',
                    fundingRate: 0,
                    entryPrice: 0
                } as IDetailedPosition;
            }).filter((p): p is IDetailedPosition => p !== null);
        } catch (err) {
            console.error('[Paradex] Simple positions error:', err);
            return [];
        }
    }
}
