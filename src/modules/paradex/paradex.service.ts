// src/modules/paradex/paradex.service.ts

import axios from 'axios';
import { ec, typedData as starkTypedData, TypedData, shortString } from 'starknet';
import { getUnixTime } from 'date-fns';

// =================================================================
// ИНТЕРФЕЙСЫ: "КОНТРАКТЫ" ДЛЯ ДАННЫХ API
// =================================================================

// Тип для ответа от /v1/account
interface ParadexAccountResponse {
    account_value?: string;
    maintenance_margin_requirement?: string;
}

// Тип для одной позиции из ответа /v1/positions
interface ParadexPosition {
    status?: 'OPEN' | 'CLOSED';
    cost_usd?: string;
    unrealized_pnl?: string
    unrealized_funding_pnl?: string
}

// Тип для полного ответа от /v1/positions, который содержит массив позиций
interface ParadexPositionsResponse {
    results: ParadexPosition[];
}


// --- Остальные типы для аутентификации ---
type UnixTime = number;
interface AuthRequest extends Record<string, unknown> {
    method: string;
    path: string;
    body: string;
    timestamp: UnixTime;
    expiration: UnixTime;
}
const PARADEX_API_URL = 'https://api.prod.paradex.trade/v1';
const STARKNET_CHAIN_ID = shortString.encodeShortString("PRIVATE_SN_PARACLEAR_MAINNET");

// =================================================================
// СЕРВИС: МОЗГ ПРИЛОЖЕНИЯ
// =================================================================

export class ParadexService {
    private readonly SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    private readonly accountAddress: string;
    private readonly privateKey: string;

    constructor() {
        const address = process.env.ACCOUNT_ADDRESS;
        const key = process.env.ACCOUNT_PRIVATE_KEY;

        if (!address || !key) {
            throw new Error('Paradex ACCOUNT_ADDRESS and ACCOUNT_PRIVATE_KEY must be provided in .env file');
        }
        this.accountAddress = address;
        this.privateKey = key;
    }

    // --- ПРИВАТНЫЕ МЕТОДЫ АУТЕНТИФИКАЦИИ (без изменений) ---

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

    private buildAuthTypedData(request: AuthRequest): TypedData {
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
        const request: AuthRequest = { method: "POST", path: "/v1/auth", body: "", timestamp, expiration };
        const typedData = this.buildAuthTypedData(request);
        const signature = this.signatureFromTypedData(typedData);
        return { signature, timestamp, expiration };
    }

    private async getJwtToken(): Promise<string> {
        try {
            const { signature, timestamp, expiration } = this.signAuthRequest();
            const headers = { 'Accept': 'application/json', 'PARADEX-STARKNET-ACCOUNT': this.accountAddress, 'PARADEX-STARKNET-SIGNATURE': signature, 'PARADEX-TIMESTAMP': timestamp.toString(), 'PARADEX-SIGNATURE-EXPIRATION': expiration.toString() };
            const response = await axios.post(`${PARADEX_API_URL}/auth`, {}, { headers });
            return response.data.jwt_token;
        } catch (error) {
            throw new Error(`Failed to get JWT token: ${this.getErrorMessage(error)}`);
        }
    }

    // --- НОВЫЕ ПРИВАТНЫЕ МЕТОДЫ ДЛЯ ПОЛУЧЕНИЯ ДАННЫХ ---

    private async getAccount(jwtToken: string): Promise<ParadexAccountResponse> {
        const headers = { 'Accept': 'application/json', 'Authorization': `Bearer ${jwtToken}` };
        const response = await axios.get(`${PARADEX_API_URL}/account`, { headers });
        return response.data;
    }

    private async getPositions(jwtToken: string): Promise<ParadexPositionsResponse> {
        const headers = { 'Accept': 'application/json', 'Authorization': `Bearer ${jwtToken}` };
        const response = await axios.get(`${PARADEX_API_URL}/positions`, { headers });
        return response.data;
    }

    // --- ЕДИНЫЙ ПУБЛИЧНЫЙ МЕТОД ДЛЯ РАСЧЕТА ПЛЕЧА ---

    public async calculateLeverage(): Promise<number> {
        try {
            const jwtToken = await this.getJwtToken();

            // 1. Получаем все "сырые" данные параллельно
            const [accountData, positionsResponse] = await Promise.all([
                this.getAccount(jwtToken),
                this.getPositions(jwtToken),
            ]);

            // 2. "Фейсконтроль" для данных
            if (
                typeof accountData?.account_value !== 'string' ||
                typeof accountData?.maintenance_margin_requirement !== 'string' ||
                !Array.isArray(positionsResponse?.results)
            ) {
                throw new Error('Incomplete or invalid data received from Paradex API.');
            }

            // 3. Выполняем вычисления
            const accountValue = parseFloat(accountData.account_value);
            const maintMargin = parseFloat(accountData.maintenance_margin_requirement);

            if (isNaN(accountValue) || isNaN(maintMargin)) {
                throw new Error('Failed to parse financial data from Paradex API response.');
            }

            // Суммируем стоимость только ОТКРЫТЫХ позиций
            const totalCostUsd = positionsResponse.results
                .filter(p => p.status === 'OPEN')
                .reduce((sum, p) => {
                    const absCost = Math.abs(parseFloat(p.cost_usd || '0'));
                    const unrealizedPnl = parseFloat(p.unrealized_pnl || '0');
                    const unrealized_funding_pnl = parseFloat(p.unrealized_funding_pnl || '0')
                    return sum + (absCost - unrealizedPnl - unrealized_funding_pnl);
                }, 0);

            // Если открытых позиций нет, плечо равно 0
            if (totalCostUsd === 0) {
                return 0;
            }

            const denominator = accountValue - maintMargin;
            if (denominator === 0) {
                throw new Error('Cannot calculate leverage: Division by zero.');
            }

            const leverage = totalCostUsd / denominator;

            if (!isFinite(leverage)) {
                throw new Error('Leverage calculation resulted in a non-finite number.');
            }

            return leverage;

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error during Paradex leverage calculation:', err);
            throw new Error(`Failed to calculate Paradex leverage: ${message}`);
        }
    }
}