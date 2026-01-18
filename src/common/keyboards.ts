import { Markup } from 'telegraf';

export const mainMenuKeyboard = Markup.keyboard([
    ['Trade-BOT', 'Fundings']
]).resize();

export const tradeBotKeyboard = Markup.keyboard([
    ['Плечи', 'Позиции', 'bp', 'Мониторинг'],
    ['OPEN POS', 'Ручная проверка', 'Автоматическая проверка'],
    ['Настройки', '🔙 Назад в меню']
]).resize();

export const fundingMenuKeyboard = Markup.keyboard([
    ['Фандинги Поз', '🏆 Лучшие монеты'],
    ['🔍 Фандинг монеты', '🔍 Окупаемость монеты'],
    ['⚙️ Настройки', '🔙 Назад в меню']
]).resize();
