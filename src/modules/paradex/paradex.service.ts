// src/modules/paradex/paradex.service.ts

import axios from 'axios'; // Убедитесь, что axios импортирован
import { ec, typedData as starkTypedData, TypedData, shortString } from 'starknet';
import { getUnixTime } from 'date-fns';

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

export class ParadexService {
    private readonly SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    private readonly accountAddress: string;
    private readonly privateKey: string;

    constructor() {
        const address = process.env.ACCOUNT_ADDRESS;
        const key = process.env.ACCOUNT_PRIVATE_KEY;

        // РЕШЕНИЕ ОШИБКИ 1: Сначала проверяем, потом присваиваем
        if (!address || !key) {
            throw new Error('Paradex ACCOUNT_ADDRESS and ACCOUNT_PRIVATE_KEY must be provided in .env file');
        }

        this.accountAddress = address;
        this.privateKey = key;
    }

    // ... другие приватные методы (generateTimestamps, buildParadexDomain и т.д.) без изменений ...

    private generateTimestamps(): { timestamp: UnixTime; expiration: UnixTime; } {
        const dateNow = new Date();
        const dateExpiration = new Date(dateNow.getTime() + this.SEVEN_DAYS_MS);
        return {
            timestamp: getUnixTime(dateNow),
            expiration: getUnixTime(dateExpiration),
        };
    }

    private buildParadexDomain() {
        return { name: "Paradex", chainId: STARKNET_CHAIN_ID, version: "1" };
    }

    private buildAuthTypedData(request: AuthRequest): TypedData {
        return {
            domain: this.buildParadexDomain(),
            primaryType: "Request",
            types: {
                StarkNetDomain: [{ name: "name", type: "felt" }, { name: "chainId", type: "felt" }, { name: "version", type: "felt" }],
                Request: [{ name: "method", type: "felt" }, { name: "path", type: "felt" }, { name: "body", type: "felt" }, { name: "timestamp", type: "felt" }, { name: "expiration", type: "felt" }],
            },
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
        const { signature, timestamp, expiration } = this.signAuthRequest();
        const headers = {
            'Accept': 'application/json',
            'PARADEX-STARKNET-ACCOUNT': this.accountAddress,
            'PARADEX-STARKNET-SIGNATURE': signature,
            'PARADEX-TIMESTAMP': timestamp.toString(),
            'PARADEX-SIGNATURE-EXPIRATION': expiration.toString(),
        };
        try {
            const response = await axios.post(`${PARADEX_API_URL}/auth`, {}, { headers });
            return response.data.jwt_token;
        } catch (error) {
            // РЕШЕНИЕ ОШИБКИ 2: Проверяем тип error
            if (axios.isAxiosError(error)) {
                console.error('Ошибка Axios при получении JWT токена:', error.response?.data);
            } else {
                console.error('Неизвестная ошибка при получении JWT токена:', error);
            }
            throw new Error('Не удалось получить JWT токен');
        }
    }

    public async getAccountData() {
        const jwtToken = await this.getJwtToken();
        const headers = { 'Accept': 'application/json', 'Authorization': `Bearer ${jwtToken}` };
        try {
            const response = await axios.get(`${PARADEX_API_URL}/account`, { headers });
            return response.data;
        } catch (error) {
            // РЕШЕНИЕ ОШИБКИ 2: Проверяем тип error
            if (axios.isAxiosError(error)) {
                console.error('Ошибка Axios при получении данных аккаунта:', error.response?.data);
            } else {
                console.error('Неизвестная ошибка при получении данных аккаунта:', error);
            }
            throw new Error('Не удалось получить данные об аккаунте');
        }
    }
}