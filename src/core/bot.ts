// src/core/bot.ts
import { Telegraf } from 'telegraf';
import { config } from './config';

// Создаем и экспортируем экземпляр бота, чтобы он был доступен во всем приложении
export const bot = new Telegraf(config.botToken);

// Добавляем обработчики для корректной остановки бота
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));