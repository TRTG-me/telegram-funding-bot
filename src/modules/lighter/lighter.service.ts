import axios from 'axios';
import { IExchangeData, IDetailedPosition, ILighterApiResponse, IFundingRatesResponseLighter } from '../../common/interfaces'

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

    private async getAccountData(): Promise<ILighterApiResponse> {
        try {
            const url = `${this.API_URL}/account?by=l1_address&value=${this.l1Address}`;
            const response = await axios.get<ILighterApiResponse>(url, {
                headers: { 'accept': 'application/json' }
            });
            return response.data;
        } catch (error) {
            throw new Error(`Failed to fetch Lighter account data: ${this.getErrorMessage(error)}`);
        }
    }

    // --- НОВАЯ ФУНКЦИЯ ---
    /**
     * Получает и форматирует информацию об открытых позициях в унифицированный вид.
     * @returns Промис, который разрешается массивом детализированных позиций.
     */
    public async getDetailedPositions(): Promise<IDetailedPosition[]> {
        try {
            // --- Шаг 1: Параллельно запрашиваем данные аккаунта и ставки фандинга ---
            const [accountResponse, fundingResponse] = await Promise.all([
                this.getAccountData(),
                axios.get<IFundingRatesResponseLighter>(`${this.API_URL}/funding-rates`)
            ]);

            // --- Шаг 2: Проверяем наличие и структуру данных ---
            const account = accountResponse?.accounts?.[0];
            const fundingRates = fundingResponse?.data?.funding_rates;

            if (!account || !Array.isArray(account.positions) || !Array.isArray(fundingRates)) {
                throw new Error('Incomplete or invalid data received from Lighter API.');
            }

            // --- Шаг 3: Создаем карту для быстрого доступа к ставкам фандинга ---
            const fundingMap = new Map<string, number>();
            fundingRates
                .filter(rate => rate.exchange === 'lighter') // Оставляем только фандинг от самой биржи Lighter
                .forEach(rate => {
                    fundingMap.set(rate.symbol, rate.rate);
                });

            // --- Шаг 4: Фильтруем и преобразуем открытые позиции ---
            const detailedPositions: IDetailedPosition[] = account.positions
                .filter(p => parseFloat(p.position || '0') !== 0) // Оставляем только открытые
                .map(position => {
                    const coin = position.symbol!;
                    // API отдает ставку уже в виде готового числа, умножаем на 100 для получения процентов
                    const fundingRate = (fundingMap.get(coin) || 0) * 100;

                    return {
                        coin: coin,
                        notional: Math.abs(parseFloat(position.position_value || '0')).toString(),
                        size: Math.abs(parseFloat(position.position || '0')),
                        side: position.sign === 1 ? 'L' : 'S',
                        exchange: 'L', // 'L' для Lighter
                        fundingRate: fundingRate,
                    };
                });

            return detailedPositions;

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error fetching Lighter detailed positions:', err);
            throw new Error(`Failed to get detailed positions from Lighter: ${message}`);
        }
    }


    public async calculateLeverage(): Promise<IExchangeData> {
        try {
            const response = await this.getAccountData();

            const account = response?.accounts?.[0];
            if (!account || typeof account.total_asset_value !== 'string' || typeof account.available_balance !== 'string' || !Array.isArray(account.positions)) {
                throw new Error('Incomplete or invalid data received from Lighter API.');
            }

            const totalAssetValue = parseFloat(account.total_asset_value);
            const availableBalance = parseFloat(account.available_balance);

            if (isNaN(totalAssetValue) || isNaN(availableBalance)) {
                throw new Error('Failed to parse financial data from Lighter API response.');
            }

            const totalPositionValue = account.positions
                .filter(p => parseFloat(p.position || '0') !== 0)
                .reduce((sum, p) => sum + Math.abs(parseFloat(p.position_value || '0')), 0);

            if (totalPositionValue === 0) {
                return { leverage: 0, accountEquity: totalAssetValue };
            }

            const maintenanceMargin = (totalAssetValue - availableBalance) * 0.6;
            const denominator = totalAssetValue - maintenanceMargin;

            if (denominator <= 0) {
                throw new Error('Cannot calculate leverage: Invalid denominator.');
            }

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