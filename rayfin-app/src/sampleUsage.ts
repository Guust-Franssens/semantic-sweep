// Synthetic usage/metadata for the built-in "usage demo" estate (see usageDemo.ts). Lets the app
// demo the FULL recommendation taxonomy with NO tenant, NO capacity and NO admin rights. Headers are
// deliberately messy (spaces, slashes, alternate names) to exercise the column auto-mapper.
//
// Reference "now" for the dormancy math is 2026-07-05 (see SAMPLE_USAGE_NOW).
export const SAMPLE_USAGE_NOW = "2026-07-05T00:00:00Z";

export const sampleUsageCsv = `Workspace,Dataset,Owner,Endorsement,Created,Last Refresh,Avg Refresh (min),Refreshes/Week,Distinct Users,Views,Last Accessed,Size (MB),Downstream Reports
Sales Analytics,Sales Performance,maria.lopez@contoso.com,Certified,2024-02-11,2026-07-04,7.5,35,142,3100,2026-07-05,540,6
Sales West,Sales Performance (copy),sam.taylor@contoso.com,None,2024-06-01,2026-04-10,6.2,7,0,0,2025-05-20,210,0
Sales West,Depletions Dashboard,sam.taylor@contoso.com,None,2025-01-15,2026-07-03,5.1,35,28,240,2026-07-01,180,3
Sales East,Regional Sales,priya.nair@contoso.com,Certified,2024-03-20,2026-07-02,6.8,21,12,410,2026-07-01,260,2
Exec Reporting,Sales Performance QBR,alex.kim@contoso.com,None,2024-09-10,2026-03-05,4.4,4,0,0,2026-03-01,95,1
Sales West,Sales Perf v2,sam.taylor@contoso.com,None,2026-05-01,2026-07-01,5.0,20,5,60,2026-07-01,150,1
`;

