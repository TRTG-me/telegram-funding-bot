// src/modules/extended/extended.service.ts

import axios from 'axios';
import { IExchangeData, IDetailedPosition } from '../../common/interfaces';

// =================================================================
// ИНТЕРФЕЙСЫ
// =================================================================

interface ExtendedBalanceData {
    exposure?: string;
    equity?: string;
    initialMargin?: string;
}

interface ExtendedApiResponse {
    status?: string;
    data?: ExtendedBalanceData;
}

// --- НОВЫЕ ИНТЕРФЕЙСЫ для позиций и фандинга ---

interface ExtendedPosition {
    market: string;
    status: 'OPENED' | 'CLOSED';
    side: 'LONG' | 'SHORT';
    size: string;
    value: string;
}

interface ExtendedPositionsResponse {
    status: 'OK' | 'ERROR';
    data: ExtendedPosition[];
}

interface ExtendedMarketStatsData {
    fundingRate: string;
}

interface ExtendedMarketStatsResponse {
    status: 'OK' | 'ERROR';
    data: ExtendedMarketStatsData;
}


// =================================================================
// СЕРВИС
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

    private async getAccountBalance(): Promise<ExtendedApiResponse> {
        try {
            const response = await axios.get(`${this.API_URL}/user/balance`, {
                headers: { 'X-Api-Key': this.apiKey, 'User-Agent': 'TelegramTradingBot/1.0.0' },
            });
            return response.data;
        } catch (error) {
            throw new Error(`Failed to fetch Extended Exchange balance: ${this.getErrorMessage(error)}`);
        }
    }

    // --- НОВЫЙ ПРИВАТНЫЙ МЕТОД для получения позиций ---
    private async getUserPositions(): Promise<ExtendedPositionsResponse> {
        try {
            const response = await axios.get(`${this.API_URL}/user/positions`, {
                headers: { 'X-Api-Key': this.apiKey, 'User-Agent': 'TelegramTradingBot/1.0.0' },
            });
            return response.data;
        } catch (error) {
            throw new Error(`Failed to fetch Extended Exchange positions: ${this.getErrorMessage(error)}`);
        }
    }

    // --- НОВАЯ ФУНКЦИЯ ---
    /**
     * Получает и форматирует информацию об открытых позициях в унифицированный вид.
     * @returns Промис, который разрешается массивом детализированных позиций.
     */
    public async getDetailedPositions(): Promise<IDetailedPosition[]> {
        try {
            // --- Шаг 1: Получаем список всех позиций ---
            const positionsResponse = await this.getUserPositions();

            if (positionsResponse.status !== 'OK' || !Array.isArray(positionsResponse.data)) {
                throw new Error('Invalid positions data received from Extended Exchange API.');
            }

            // --- Шаг 2: Фильтруем только ОТКРЫТЫЕ позиции ---
            const openPositions = positionsResponse.data.filter(p => p.status === 'OPENED');

            // --- Шаг 3: Асинхронно получаем детали для каждой открытой позиции ---
            const detailedPositionsPromises = openPositions.map(async (position): Promise<IDetailedPosition> => {
                const market = position.market; // e.g., "MNT-USD"

                // Для каждой позиции запрашиваем ее статистику для получения фандинга
                const statsResponse = await axios.get<ExtendedMarketStatsResponse>(`${this.API_URL}/info/markets/${market}/stats`);

                const fundingRateData = statsResponse.data.data.fundingRate;

                const fundingRate = parseFloat(fundingRateData) * 8 * 100;

                return {
                    // Убираем '-USD' из названия монеты
                    coin: market.replace(/-USD$/, ''),
                    notional: position.value,
                    size: Math.abs(parseFloat(position.size)),
                    side: position.side === 'LONG' ? 'L' : 'S',
                    exchange: 'E', // 'E' для Extended
                    fundingRate: fundingRate,
                };
            });

            // --- Шаг 4: Ожидаем выполнения всех запросов и возвращаем результат ---
            return Promise.all(detailedPositionsPromises);

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error fetching Extended Exchange detailed positions:', err);
            throw new Error(`Failed to get detailed positions from Extended Exchange: ${message}`);
        }
    }


    public async calculateLeverage(): Promise<IExchangeData> {
        try {
            const response = await this.getAccountBalance();

            const data = response?.data;
            if (!data || typeof data.exposure !== 'string' || typeof data.equity !== 'string' || typeof data.initialMargin !== 'string') {
                throw new Error('Incomplete or invalid data received from Extended Exchange API.');
            }

            const exposure = parseFloat(data.exposure);
            const equity = parseFloat(data.equity);
            const initialMargin = parseFloat(data.initialMargin);

            if (isNaN(exposure) || isNaN(equity) || isNaN(initialMargin)) {
                throw new Error('Failed to parse financial data from Extended Exchange API response.');
            }

            if (exposure === 0) {
                return { leverage: 0, accountEquity: equity };
            }

            const denominator = equity - (initialMargin / 2);
            if (denominator <= 0) {
                throw new Error('Cannot calculate leverage: Invalid denominator (balance is too low).');
            }

            const leverage = exposure / denominator;
            if (!isFinite(leverage)) {
                throw new Error('Leverage calculation resulted in a non-finite number.');
            }

            return { leverage: leverage, accountEquity: equity };

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error during Extended Exchange leverage calculation:', err);
            throw new Error(`Failed to calculate Extended Exchange leverage: ${message}`);
        }
    }
}