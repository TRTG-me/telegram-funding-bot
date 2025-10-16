// src/core/config.ts
import * as dotenv from 'dotenv';

dotenv.config(); // Загружаем переменные из .env

const token = process.env.BOT_TOKEN;
if (!token) {
    throw new Error('BOT_TOKEN не найден в .env файле!');
}

export const config = {
    botToken: token,
};