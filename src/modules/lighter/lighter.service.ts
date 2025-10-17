// src/modules/lighter/lighter.service.ts
import axios from 'axios';

// Импортируем (или дублируем) тот же интерфейс, что и в контроллере
interface LighterApiResponse {
    accounts: { positions: { position: string }[] }[]; // Можно описать кратко, если не хотите импортировать
}

const LIGHTER_API_URL = 'https://mainnet.zklighter.elliot.ai/api/v1';

export class LighterService {
    private readonly l1Address: string;

    constructor() {
        const address = process.env.LIGHTER_L1_ADDRESS;
        if (!address) {
            throw new Error('Lighter LIGHTER_L1_ADDRESS must be provided in .env file');
        }
        this.l1Address = address;
    }
    public async getAccountData(): Promise<LighterApiResponse> {
        try {
            const url = `${LIGHTER_API_URL}/account?by=l1_address&value=${this.l1Address}`;
            // Используем generic <>, чтобы "сказать" axios, какой тип данных мы ожидаем
            const response = await axios.get<LighterApiResponse>(url, {
                headers: { 'accept': 'application/json' }
            });
            return response.data;
        } catch (error) {
            // ... обработка ошибок без изменений ...
            if (axios.isAxiosError(error)) {
                console.error('Ошибка Axios при получении данных от Lighter:', error.response?.data);
            } else {
                console.error('Неизвестная ошибка при получении данных от Lighter:', error);
            }
            throw new Error('Не удалось получить данные об аккаунте Lighter');
        }
    }
}