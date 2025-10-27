// src/modules/paradex/paradex.service.ts

import axios from 'axios';
import { ec, typedData as starkTypedData, TypedData, shortString } from 'starknet';
import { getUnixTime } from 'date-fns';
import { IExchangeData, IDetailedPosition, IParadexAccountResponse, IParadexPosition, IAuthRequest, IParadexPositionsResponse } from '../../common/interfaces';

// =================================================================
// ИНТЕРФЕЙСЫ
// =================================================================

type UnixTime = number;

// =================================================================
// КОНСТАНТЫ
// =================================================================

const PARADEX_API_URL = 'https://api.prod.paradex.trade/v1';
const STARKNET_CHAIN_ID = shortString.encodeShortString("PRIVATE_SN_PARACLEAR_MAINNET");

// =================================================================
// СЕРВИС
// =================================================================

export class ParadexService {
    private readonly SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    private readonly accountAddress: string;
    private readonly privateKey: string;

    // --- СВОЙСТВА ДЛЯ КЭШИРОВАНИЯ JWT ТОКЕНА ---
    private jwtToken: string | null = null;
    private tokenExpiration: number = 0;

    constructor() {
        const address = process.env.ACCOUNT_ADDRESS;
        const key = process.env.ACCOUNT_PRIVATE_KEY;

        if (!address || !key) {
            throw new Error('Paradex ACCOUNT_ADDRESS and ACCOUNT_PRIVATE_KEY must be provided in .env file');
        }
        this.accountAddress = address;
        this.privateKey = key;
    }

    // --- ПРИВАТНЫЕ МЕТОДЫ АУТЕНТИФИКАЦИИ ---

    private getErrorMessage(error: unknown): string {
        if (axios.isAxiosError(error)) {
            return JSON.stringify(error.response?.data) || error.message;
        }
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }

    private generateTimestamps(): { timestamp: UnixTime; expiration: UnixTime; } {
        const dateNow = new Date();
        const dateExpiration = new Date(dateNow.getTime() + this.SEVEN_DAYS_MS);
        return { timestamp: getUnixTime(dateNow), expiration: getUnixTime(dateExpiration) };
    }

    private buildParadexDomain() {
        return { name: "Paradex", chainId: STARKNET_CHAIN_ID, version: "1" };
    }

    private buildAuthTypedData(request: IAuthRequest): TypedData {
        return {
            domain: this.buildParadexDomain(),
            primaryType: "Request",
            types: { StarkNetDomain: [{ name: "name", type: "felt" }, { name: "chainId", type: "felt" }, { name: "version", type: "felt" }], Request: [{ name: "method", type: "felt" }, { name: "path", type: "felt" }, { name: "body", type: "felt" }, { name: "timestamp", type: "felt" }, { name: "expiration", type: "felt" }] },
            message: request,
        };
    }

    private signatureFromTypedData(typedData: TypedData): string {
        const msgHash = starkTypedData.getMessageHash(typedData, this.accountAddress);
        const { r, s } = ec.starkCurve.sign(msgHash, this.privateKey);
        return JSON.stringify([r.toString(), s.toString()]);
    }

    private signAuthRequest(): { signature: string; timestamp: UnixTime; expiration: UnixTime; } {
        const { timestamp, expiration } = this.generateTimestamps();
        const request: IAuthRequest = { method: "POST", path: "/v1/auth", body: "", timestamp, expiration };
        const typedData = this.buildAuthTypedData(request);
        const signature = this.signatureFromTypedData(typedData);
        return { signature, timestamp, expiration };
    }

    // --- ОПТИМИЗИРОВАННЫЙ МЕТОД ПОЛУЧЕНИЯ JWT ТОКЕНА С КЭШИРОВАНИЕМ ---
    private async getJwtToken(): Promise<string> {
        if (this.jwtToken && this.tokenExpiration > Date.now()) {
            return this.jwtToken;
        }

        try {
            const { signature, timestamp, expiration } = this.signAuthRequest();
            const headers = { 'Accept': 'application/json', 'PARADEX-STARKNET-ACCOUNT': this.accountAddress, 'PARADEX-STARKNET-SIGNATURE': signature, 'PARADEX-TIMESTAMP': timestamp.toString(), 'PARADEX-SIGNATURE-EXPIRATION': expiration.toString() };
            const response = await axios.post(`${PARADEX_API_URL}/auth`, {}, { headers });

            this.jwtToken = response.data.jwt_token;
            this.tokenExpiration = Date.now() + this.SEVEN_DAYS_MS - (60 * 60 * 1000); // Кэш на 7 дней минус 1 час

            return this.jwtToken!;
        } catch (error) {
            this.jwtToken = null;
            this.tokenExpiration = 0;
            throw new Error(`Failed to get JWT token: ${this.getErrorMessage(error)}`);
        }
    }

    // --- ПРИВАТНЫЕ МЕТОДЫ ДЛЯ ПОЛУЧЕНИЯ ДАННЫХ ---

    private async getAccount(jwtToken: string): Promise<IParadexAccountResponse> {
        const headers = { 'Accept': 'application/json', 'Authorization': `Bearer ${jwtToken}` };
        const response = await axios.get(`${PARADEX_API_URL}/account`, { headers });
        return response.data;
    }

    private async getPositions(jwtToken: string): Promise<IParadexPositionsResponse> {
        const headers = { 'Accept': 'application/json', 'Authorization': `Bearer ${jwtToken}` };
        const response = await axios.get(`${PARADEX_API_URL}/positions`, { headers });
        return response.data;
    }

    // --- НОВЫЕ ПРИВАТНЫЕ HELPER-МЕТОДЫ ДЛЯ УСТРАНЕНИЯ ДУБЛИРОВАНИЯ ---

    private _calculatePositionNotional(position: IParadexPosition): number {
        const absCost = Math.abs(parseFloat(position.cost_usd || '0'));
        const unrealizedPnl = parseFloat(position.unrealized_pnl || '0');
        const unrealizedFundingPnl = parseFloat(position.unrealized_funding_pnl || '0');
        return absCost - unrealizedPnl + unrealizedFundingPnl;
    }

    private async _getOpenPositions(jwtToken: string): Promise<IParadexPosition[]> {
        const positionsResponse = await this.getPositions(jwtToken);
        if (!Array.isArray(positionsResponse?.results)) {
            throw new Error('Invalid positions data received from Paradex API.');
        }
        return positionsResponse.results.filter(p => p.status === 'OPEN');
    }

    // --- РЕФАКТОРЕННЫЕ ПУБЛИЧНЫЕ МЕТОДЫ ---

    public async getDetailedPositions(): Promise<IDetailedPosition[]> {
        try {
            const jwtToken = await this.getJwtToken();
            const openPositions = await this._getOpenPositions(jwtToken);
            const headers = { 'Accept': 'application/json', 'Authorization': `Bearer ${jwtToken}` };

            const detailedPositionsPromises = openPositions.map(async (position): Promise<IDetailedPosition | null> => {
                if (!position.market) {
                    console.warn('Skipping position due to missing market field:', position);
                    return null;
                }
                const symbol = position.market;

                const [marketDetailsResponse, marketSummaryResponse] = await Promise.all([
                    axios.get(`${PARADEX_API_URL}/markets?market=${symbol}`, { headers }),
                    axios.get(`${PARADEX_API_URL}/markets/summary?market=${symbol}`, { headers })
                ]);

                const marketDetails = marketDetailsResponse.data.results[0];
                const marketSummary = marketSummaryResponse.data.results[0];

                const notional = this._calculatePositionNotional(position);

                let fundingRate = parseFloat(marketSummary.funding_rate || '0');
                if (marketDetails.funding_period_hours === 4) {
                    fundingRate *= 2;
                }

                return {
                    coin: symbol.replace(/-USD-PERP$/, ''),
                    notional: notional.toString(),
                    size: Math.abs(parseFloat(position.size || '0')),
                    side: position.side === 'LONG' ? 'L' : 'S',
                    exchange: 'P',
                    fundingRate: fundingRate * 100,
                };
            });

            const results = await Promise.all(detailedPositionsPromises);
            return results.filter((p): p is IDetailedPosition => p !== null);

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error fetching Paradex detailed positions:', err);
            throw new Error(`Failed to get detailed positions from Paradex: ${message}`);
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
                throw new Error('Cannot calculate leverage: Division by zero.');
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
}