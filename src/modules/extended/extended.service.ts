// src/modules/extended/extended.service.ts

import axios from 'axios';

// =================================================================
// ИНТЕРФЕЙСЫ: "КОНТРАКТЫ" ДЛЯ ДАННЫХ API
// =================================================================

// Описывает вложенный объект 'data' в ответе API
interface ExtendedBalanceData {
    exposure?: string;
    equity?: string;
    initialMargin?: string;
}

// Описывает корневой объект ответа API
interface ExtendedApiResponse {
    status?: string;
    data?: ExtendedBalanceData;
}

// =================================================================
// СЕРВИС: МОЗГ ПРИЛОЖЕНИЯ
// =================================================================

export class ExtendedService {
    private readonly API_URL = 'https://api.starknet.extended.exchange/api/v1';
    private readonly apiKey: string;

    constructor() {
        const key = process.env.EXTENDED_API_KEY;
        if (!key) {
            throw new Error('Extended Exchange EXTENDED_API_KEY must be provided in .env file');
        }
        this.apiKey = key;
    }

    private getErrorMessage(error: unknown): string {
        if (axios.isAxiosError(error)) {
            return JSON.stringify(error.response?.data) || error.message;
        }
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }

    /**
     * Получает "сырые" данные о балансе с API.
     */
    private async getAccountBalance(): Promise<ExtendedApiResponse> {
        try {
            const response = await axios.get(`${this.API_URL}/user/balance`, {
                headers: {
                    'X-Api-Key': this.apiKey,
                    'User-Agent': 'TelegramTradingBot/1.0.0',
                },
            });
            return response.data;
        } catch (error) {
            throw new Error(`Failed to fetch Extended Exchange balance: ${this.getErrorMessage(error)}`);
        }
    }

    /**
     * Выполняет всю логику: получает данные, вычисляет плечо и возвращает число.
     */
    public async calculateLeverage(): Promise<number> {
        try {
            const response = await this.getAccountBalance();

            // 1. "Фейсконтроль": Проверяем наличие и структуру данных
            const data = response?.data;
            if (
                !data ||
                typeof data.exposure !== 'string' ||
                typeof data.equity !== 'string' ||
                typeof data.initialMargin !== 'string'
            ) {
                throw new Error('Incomplete or invalid data received from Extended Exchange API.');
            }
            console.log(data)
            // 2. Парсим основные значения
            const exposure = parseFloat(data.exposure);
            const equity = parseFloat(data.equity);
            const initialMargin = parseFloat(data.initialMargin);

            if (isNaN(exposure) || isNaN(equity) || isNaN(initialMargin)) {
                throw new Error('Failed to parse financial data from Extended Exchange API response.');
            }

            // Если нет позиций (exposure == 0), то и плечо 0
            if (exposure === 0) {
                return 0;
            }

            // 3. Рассчитываем знаменатель по вашей формуле
            const denominator = equity - (initialMargin / 2);

            if (denominator <= 0) {
                throw new Error('Cannot calculate leverage: Invalid denominator (balance is too low).');
            }

            // 4. Финальный расчет и проверка
            const leverage = exposure / denominator;

            if (!isFinite(leverage)) {
                throw new Error('Leverage calculation resulted in a non-finite number.');
            }

            return leverage;

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error during Extended Exchange leverage calculation:', err);
            throw new Error(`Failed to calculate Extended Exchange leverage: ${message}`);
        }
    }
}