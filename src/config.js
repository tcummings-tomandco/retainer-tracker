'use strict';

const CLICKUP_BASE  = 'https://api.clickup.com/api/v2';
const CACHE_SECONDS = 14400;

const CF = {
  BILLING:         '11d732c3-5924-4784-8031-d7dcd38355e0',
  RETAINER_BUDGET: '83ab974c-51d1-4409-a791-94f3b1e3bbe5',
  QUOTE_HOURS:     '3c706ecb-1c3b-422f-be30-734bffbb8364',
  BALANCE:         'f0db275c-2bd8-4024-9ba5-3545e58a80f0',
  BILLING_TYPE:    'd90217b7-a252-49c7-bff6-451513011f9d', // 0=Retainer, 1=Project, 2=Not Billable, 3=Epic
};

const PIPELINE_STATUSES = [
  'in scoping', 'client quote feedback', 'quote given',
  'in discovery', 'in refinement', 'scheduled',
  'in progress', 'in client approval', 'in live approval',
];

// Indices verified against ClickUp dropdown on 30 Apr 2026.
// May 26 was added as option 0 (prepended), shifting all prior months by +1.
// IMPORTANT: when a new billing month is added in ClickUp, re-verify these
// indices by running: fetchBillingListField() or checking /list/:id/field.
const BILLING_TO_IDX = {
  'May 26':0,'Apr 26':1,'Mar 26':2,'Feb 26':3,'Jan 26':4,
  'Dec 25':5,'Nov 25':6,'Oct 25':7,'Sep 25':8,
  'Aug 25':9,'Jul 25':10,'Jun 25':11,'May 25':12,
  'Apr 25':13,'Mar 25':14,'Feb 25':15,'Jan 25':16,
  'Dec 24':17,'Nov 24':18,'Oct 24':19,'Sep 24':20,
  'Aug 24':21,'Jul 24':22,'Jun 24':23,'May 24':24,
  'Apr 24':25,'Mar 24':26,'Feb 24':27,'Jan 24':28,
  'Dec 23':29,'Nov 23':30,'Oct 23':31,'Sep 23':32,
  'Aug 23':33,'Jul 23':34,'Jun 23':35,'May 23':36,
  'Apr 23':37,'Mar 23':38,'Feb 23':39,'Jan 23':40,
  'Dec 22':41,'Nov 22':42,'Oct 22':43,'Sep 22':44,
  'Aug 22':45,'Jul 22':46,'Jun 22':47,'May 22':48,
  'Apr 22':49,'Mar 22':50,'Feb 22':51,'Jan 22':52,
  'Dec 21':53,'Nov 21':54,'Oct 21':55,'Sep 21':56,
  'Aug 21':57,'Jul 21':58,'Jun 21':59,'May 21':60,
  'Apr 21':61,'Mar 21':62,'Feb 21':63,'Jan 21':64,
  'Monthly':65,'PAYG':66,
  // Future months — indices are placeholders; update when added to ClickUp dropdown
  'Jun 26':67,'Jul 26':68,'Aug 26':69,'Sep 26':70,
  'Oct 26':71,'Nov 26':72,'Dec 26':73,
};

const IDX_TO_BILLING = Object.fromEntries(
  Object.entries(BILLING_TO_IDX).map(([k, v]) => [String(v), k])
);

const ALL_MONTHS = [
  'Jan 25','Feb 25','Mar 25','Apr 25','May 25','Jun 25',
  'Jul 25','Aug 25','Sep 25','Oct 25','Nov 25','Dec 25',
  'Jan 26','Feb 26','Mar 26','Apr 26','May 26','Jun 26',
  'Jul 26','Aug 26','Sep 26','Oct 26','Nov 26','Dec 26',
];

const CLIENTS = [
  { name:'LeMieux',            spaceId:'38425510',     billingListId:'164518227',    retainerTasksListId:'164518228',    hasRetainerBudget:true  },
  { name:'Barker & Stonehouse',spaceId:'44455613',     billingListId:'194684252',    retainerTasksListId:'194684224',    hasRetainerBudget:false },
  { name:'MyFujifilm',         spaceId:'38632396',     billingListId:'188410568',    retainerTasksListId:'188410569',    hasRetainerBudget:false },
  { name:'Oak & More',         spaceId:'8760031',      billingListId:'50721909',     retainerTasksListId:'50721910',     hasRetainerBudget:false },
  { name:'David Nieper',       spaceId:'90120159925',  billingListId:'901200539943', retainerTasksListId:'901200539944', hasRetainerBudget:false },
  { name:"Millie's Cookies",   spaceId:'8735321',      billingListId:'134514344',    retainerTasksListId:'48763971',     hasRetainerBudget:false },
  { name:'Time Products',      spaceId:'10806984',     billingListId:'61333095',     retainerTasksListId:'61333096',     hasRetainerBudget:false },
  { name:'Agent Provocateur',  spaceId:'8767978',      billingListId:'50772425',     retainerTasksListId:'50772426',     hasRetainerBudget:false },
];

module.exports = { CLICKUP_BASE, CACHE_SECONDS, CF, PIPELINE_STATUSES, BILLING_TO_IDX, IDX_TO_BILLING, ALL_MONTHS, CLIENTS };
