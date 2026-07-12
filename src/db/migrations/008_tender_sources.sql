-- Government tender portal sources (global)
INSERT INTO sources (name, type, category, config) VALUES
  ('TED Europa - IT Services', 'rss', 'Government Tender', '{"url": "https://ted.europa.eu/TED/search/search.do?tabId=1&searchType=1&query=IT+services+software&scope=1&sortColumn=PUBLICATION_DATE&sortOrder=DESC&format=RSS"}'),
  ('TED Europa - Digital Transformation', 'rss', 'Government Tender', '{"url": "https://ted.europa.eu/TED/search/search.do?tabId=1&searchType=1&query=digital+transformation&scope=1&sortColumn=PUBLICATION_DATE&sortOrder=DESC&format=RSS"}'),
  ('World Bank Procurement - ICT', 'rss', 'Government Tender', '{"url": "https://www.worldbank.org/en/projects-operations/procurement?lang__exact=English&type__exact=Request+for+Proposals&majorSector__exact=Information+and+Communications+Technologies&format=rss"}'),
  ('UNGM - IT & Telecom', 'rss', 'Government Tender', '{"url": "https://www.ungm.org/Public/Notice/SearchNotices?noticeType=0&deadline=&country=&agencyId=&title=IT+software&categoryId=&format=rss"}'),
  ('African Development Bank - Procurement', 'rss', 'Government Tender', '{"url": "https://www.afdb.org/en/projects-and-operations/procurement/rss"}'),
  ('SAM.gov - IT Software Development', 'rss', 'Government Tender', '{"url": "https://sam.gov/api/prod/rssservice/opportunities?naics=541511"}'),
  ('SAM.gov - Web Development', 'rss', 'Government Tender', '{"url": "https://sam.gov/api/prod/rssservice/opportunities?naics=541519"}'),
  ('EU Funding - Digital', 'rss', 'Government Tender', '{"url": "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-search;callCode=null;freeTextSearchKeyword=digital;matchWholeText=true;typeCodes=0,1;statusCodes=31094501;programmePeriod=null;programCcm2Id=null;programDivisionCode=null;focusAreaCode=null;destination=null;mission=null;geographicalZonesCode=null;countryCode=null;startDateLte=null;startDateGte=null;crossCuttingPriorityCode=null;cpvCode=null;performanceOfDelivery=null;sortQuery=sortStatus;orderBy=asc;onlyTenders=false;topicListKey=topicSearchTablePageState/rss"}'),
  ('IADB - Technology Procurement', 'rss', 'Government Tender', '{"url": "https://www.iadb.org/en/projects/procurement/feed"}'),
  ('Nigeria BPP Tenders', 'rss', 'Government Tender', '{"url": "https://www.bpp.gov.ng/feed/"}'),
  ('Kenya Public Procurement - ICT', 'google_search', 'Government Tender', '{"query": "site:ppip.go.ke OR site:ppra.go.ke \"information technology\" OR \"software\" tender 2026"}'),
  ('South Africa SITA Tenders', 'google_search', 'Government Tender', '{"query": "site:sita.co.za tender OR \"request for proposal\" software"}'),
  ('Ghana Public Procurement', 'google_search', 'Government Tender', '{"query": "site:ppa.gov.gh \"information technology\" OR \"software development\" tender"}')
ON CONFLICT DO NOTHING;
