// src/modules/lighter/lighter.service.ts

import axios from 'axios';
import { IExchangeData } from '../../common/interfaces'

// =================================================================
// ИНТЕРФЕЙСЫ: "КОНТРАКТЫ" ДЛЯ ДАННЫХ API
// =================================================================

// Описывает одну позицию внутри аккаунта
interface LighterPosition {
    symbol?: string;
    position?: string;        // Размер позиции, "0.00" если закрыта
    position_value?: string;

}

// Описывает один аккаунт из массива 'accounts'
interface LighterAccount {
    available_balance?: string;
    total_asset_value?: string;
    positions?: LighterPosition[];
}

// Описывает корневой объект ответа API
interface LighterApiResponse {
    accounts?: LighterAccount[];
}

// =================================================================
// СЕРВИС: МОЗГ ПРИЛОЖЕНИЯ
// =================================================================

export class LighterService {
    private readonly API_URL = 'https://mainnet.zklighter.elliot.ai/api/v1';
    private readonly l1Address: string;

    constructor() {
        const address = process.env.LIGHTER_L1_ADDRESS;
        if (!address) {
            throw new Error('Lighter LIGHTER_L1_ADDRESS must be provided in .env file');
        }
        this.l1Address = address;
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
     * Получает "сырые" данные об аккаунте с API.
     */
    private async getAccountData(): Promise<LighterApiResponse> {
        try {
            const url = `${this.API_URL}/account?by=l1_address&value=${this.l1Address}`;
            const response = await axios.get<LighterApiResponse>(url, {
                headers: { 'accept': 'application/json' }
            });
            return response.data;
        } catch (error) {
            throw new Error(`Failed to fetch Lighter account data: ${this.getErrorMessage(error)}`);
        }
    }

    /**
     * Выполняет всю логику: получает данные, вычисляет плечо и возвращает число.
     */
    public async calculateLeverage(): Promise<IExchangeData> {
        try {
            const response = await this.getAccountData();

            // 1. "Фейсконтроль": Проверяем наличие и структуру данных
            const account = response?.accounts?.[0]; // Берем первый аккаунт
            if (
                !account ||
                typeof account.total_asset_value !== 'string' ||
                typeof account.available_balance !== 'string' ||
                !Array.isArray(account.positions)
            ) {
                throw new Error('Incomplete or invalid data received from Lighter API.');
            }

            // 2. Парсим основные значения
            const totalAssetValue = parseFloat(account.total_asset_value);
            const availableBalance = parseFloat(account.available_balance);

            if (isNaN(totalAssetValue) || isNaN(availableBalance)) {
                throw new Error('Failed to parse financial data from Lighter API response.');
            }

            // 3. Рассчитываем числитель (сумма стоимостей открытых позиций)
            const totalPositionValue = account.positions
                // Фильтруем только открытые позиции (где размер не равен нулю)
                .filter(p => parseFloat(p.position || '0') !== 0)
                // Суммируем, используя МОДУЛЬ (Math.abs) для корректного учета шортов
                .reduce((sum, p) => sum + Math.abs(parseFloat(p.position_value || '0')), 0);

            // Если открытых позиций нет, плечо равно 0
            if (totalPositionValue === 0) {
                return { leverage: 0, accountEquity: totalAssetValue };
            }

            // 4. Рассчитываем знаменатель по вашей формуле
            const maintenanceMargin = (totalAssetValue - availableBalance) * 0.6;
            const denominator = totalAssetValue - maintenanceMargin;

            if (denominator <= 0) {
                throw new Error('Cannot calculate leverage: Invalid denominator (total asset value is less than or equal to maintenance margin).');
            }

            // 5. Финальный расчет и проверка
            const leverage = totalPositionValue / denominator;

            if (!isFinite(leverage)) {
                throw new Error('Leverage calculation resulted in a non-finite number.');
            }

            return { leverage, accountEquity: totalAssetValue };

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error during Lighter leverage calculation:', err);
            throw new Error(`Failed to calculate Lighter leverage: ${message}`);
        }
    }
}