import axios from 'axios';

const EXTENDED_API_URL = 'https://api.starknet.extended.exchange/api/v1';

export class ExtendedService {
    private readonly apiKey: string;

    constructor() {
        const key = process.env.EXTENDED_API_KEY;

        if (!key) {
            throw new Error('Extended Exchange EXTENDED_API_KEY must be provided in .env file');
        }
        this.apiKey = key;
    }

    /**
     * Получает информацию об открытых позициях.
     */
    public async getOpenPositions() {
        try {
            const response = await axios.get(`${EXTENDED_API_URL}/user/balance`, {
                headers: {
                    'X-Api-Key': this.apiKey,
                    // Добавляем User-Agent, это хорошая практика
                    'User-Agent': 'TelegramTradingBot/1.0.0',
                },
            });
            return response.data;
        } catch (error) {
            if (axios.isAxiosError(error)) {
                console.error('Ошибка Axios при получении данных от Extended Exchange:', error.response?.data);
            } else {
                console.error('Неизвестная ошибка при получении данных от Extended Exchange:', error);
            }
            throw new Error('Не удалось получить данные о позициях от Extended Exchange');
        }
    }
}