export const INCOME = [
  ['Salary', 'payments'], ['Hourly Wages', 'schedule'], ['Business Income', 'storefront'],
  ['Freelance Income', 'draw'], ['Bonuses and Commissions', 'workspace_premium'],
  ['Investment Income', 'trending_up'], ['Rental Income', 'apartment'],
  ['Retirement Income', 'elderly'], ['Passive Income', 'spa'], ['Side Hustles', 'bolt'],
  ['Gifts Received', 'redeem'], ['Tax Refund', 'receipt_long'],
  ['Subscription Reimbursement', 'autorenew'], ['Friend Transfers', 'swap_horiz'],
  ['Loaned Money Received', 'handshake']
]

export const EXPENSE = [
  ['Housing', 'home'], ['Utilities', 'lightbulb'], ['Food', 'restaurant'],
  ['Transportation', 'directions_car'], ['Medical & Healthcare', 'medical_services'],
  ['Insurance', 'shield'], ['Savings & Investments', 'savings'],
  ['Personal Spending', 'shopping_bag'], ['Debts', 'credit_card'],
  ['Education & Training', 'school'], ['Personal Care', 'face'], ['Clothing', 'checkroom'],
  ['Streaming Service', 'live_tv'], ['Recreation & Entertainment', 'attractions'],
  ['Travel', 'flight'], ['Gifts & Donations', 'volunteer_activism'], ['Pets', 'pets'],
  ['Money Lent to Friends', 'currency_exchange'], ['Debts to Friends', 'request_quote'],
  ['Other', 'category']
]

export const CATEGORY_ICON = Object.fromEntries([...INCOME, ...EXPENSE])

export const BANKS = [
  ['VisaIcon', 'Visa'], ['MastercardIcon', 'Mastercard'], ['AmericaExpressIcon', 'American Express'],
  ['BBVAIcon', 'BBVA'], ['HSBCIcon', 'HSBC'], ['BANAMEXIcon', 'Banamex'], ['BanorteIcon', 'Banorte'],
  ['SantanderIcon', 'Santander'], ['ScotiabankIcon', 'Scotiabank'], ['BanCoppelIcon', 'BanCoppel'],
  ['BancoAztecaIcon', 'Banco Azteca']
]

export const PALETTE = ['#34d27b', '#2bb3a3', '#a3e05a', '#5fc9e0', '#e0c45a', '#7a8f82']

export const RANGES = { '7D': 7, '15D': 15, '1M': 30, '6M': 183, '1Y': 365, All: 99999 }

export const RANGE_LABEL = {
  '7D': 'last 7 days', '15D': 'last 15 days', '1M': 'last 30 days',
  '6M': 'last 6 months', '1Y': 'last 12 months', All: 'all time'
}

export const SECTIONS = [
  ['balance', 'Balance & trend', 'show_chart'], ['stats', 'Period summary', 'donut_large'],
  ['cards', 'Cards', 'credit_card'], ['categories', 'Where it went', 'pie_chart'],
  ['tx', 'Transactions', 'receipt_long']
]

export const CURRENCIES = {
  MXN: { symbol: '$', name: 'Mexican peso', decimals: 2 },
  USD: { symbol: 'US$', name: 'US dollar', decimals: 2 },
  CAD: { symbol: 'CA$', name: 'Canadian dollar', decimals: 2 },
  AUD: { symbol: 'A$', name: 'Australian dollar', decimals: 2 },
  EUR: { symbol: '€', name: 'Euro', decimals: 2 },
  GBP: { symbol: '£', name: 'British pound', decimals: 2 },
  COP: { symbol: 'COL$', name: 'Colombian peso', decimals: 0 },
  JPY: { symbol: '¥', name: 'Japanese yen', decimals: 0 }
}

export const DEFAULT_SETTINGS = {
  currency: 'MXN', defaultRange: '6M', privacyOnOpen: false, budget: 0, largeAmount: 5000,
  notifications: { daily: false, weekly: false, large: false }
}

export const BILL_CATS = [
  'Housing', 'Utilities', 'Insurance', 'Debts', 'Savings & Investments',
  'Medical & Healthcare', 'Debts to Friends'
]

export const SUB_CATS = [
  'Streaming Service', 'Education & Training', 'Personal Care', 'Recreation & Entertainment'
]

export const TONES = {
  emerald: 'linear-gradient(135deg,#1f6040 0%,#0c2618 100%)',
  forest: 'linear-gradient(135deg,#114032 0%,#071a13 100%)',
  lime: 'linear-gradient(135deg,#44611f 0%,#17240b 100%)',
  graphite: 'linear-gradient(135deg,#2c3532 0%,#111615 100%)',
  onyx: 'linear-gradient(135deg,#191e1b 0%,#090b0a 100%)'
}

export const GOAL_ICONS = [
  'flight', 'shield', 'laptop_mac', 'home', 'directions_car', 'school', 'celebration', 'savings'
]
