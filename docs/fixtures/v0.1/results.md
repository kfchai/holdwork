# Verifier fixture study v0.1

Condition: independent (current pipeline; pool of three verifiers, same model family). Endpoint: https://holdwork.cortexum.ai. Runs per fixture: 10. Generated 2026-09-10T13:58:42.476Z.

Fixture text, schema and criteria are in results.json (meta.fixture) and were identical for every run; only the delivered output differed.

## Summary

| Fixture | n | mean quality | min | max | mean spread | rerun fired | schema valid | mean seconds |
|---|---|---|---|---|---|---|---|---|
| A | 10 | 0.987 | 0.980 | 1.000 | 0.016 | 10/10 | 10/10 | 86 |
| B | 10 | 0.575 | 0.484 | 0.616 | 0.083 | 3/10 | 10/10 | 165 |
| C | 10 | 0.613 | 0.574 | 0.640 | 0.056 | 4/10 | 10/10 | 197 |

## Every run

| Fixture | Run | Contract | Round | Reason | Panel | Scores | Confidence | Spread | Variance | Outcome quality | To seller | Refund |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 1 | hw_e91daa49-1f5 | 1 | DISPUTE | verifier-glm-1, verifier-glm-2, verifier-glm-3 | 1.00 / 1.00 / 1.00 | 0.98 / 0.97 / 0.98 | 0.000 | 0.00000 | 0.987 | 5 | 0 |
| A | 1 | hw_e91daa49-1f5 | 2 | COLLUSION_RERUN | verifier-glm-2, verifier-glm-3, verifier-glm-1 | 0.98 / 0.98 / 1.00 | 0.95 / 0.97 / 0.98 | 0.020 | 0.00009 | 0.987 | 5 | 0 |
| A | 2 | hw_b1a69920-f59 | 1 | DISPUTE | verifier-glm-3, verifier-glm-2, verifier-glm-1 | 1.00 / 1.00 / 0.98 | 0.98 / 0.97 / 0.97 | 0.020 | 0.00009 | 0.980 | 5 | 0 |
| A | 2 | hw_b1a69920-f59 | 2 | COLLUSION_RERUN | verifier-glm-3, verifier-glm-1, verifier-glm-2 | 0.98 / 0.98 / 0.98 | 0.97 / 0.97 / 0.97 | 0.000 | 0.00000 | 0.980 | 5 | 0 |
| A | 3 | hw_df752b9b-f20 | 1 | DISPUTE | verifier-glm-3, verifier-glm-1, verifier-glm-2 | 1.00 / 1.00 / 1.00 | 0.98 / 0.98 / 0.97 | 0.000 | 0.00000 | 0.987 | 5 | 0 |
| A | 3 | hw_df752b9b-f20 | 2 | COLLUSION_RERUN | verifier-glm-2, verifier-glm-1, verifier-glm-3 | 1.00 / 0.97 / 0.99 | 0.95 / 0.95 / 0.97 | 0.030 | 0.00016 | 0.987 | 5 | 0 |
| A | 4 | hw_1d8c5683-207 | 1 | DISPUTE | verifier-glm-1, verifier-glm-3, verifier-glm-2 | 1.00 / 1.00 / 1.00 | 0.98 / 0.97 / 0.97 | 0.000 | 0.00000 | 0.984 | 5 | 0 |
| A | 4 | hw_1d8c5683-207 | 2 | COLLUSION_RERUN | verifier-glm-2, verifier-glm-1, verifier-glm-3 | 1.00 / 0.98 / 0.97 | 0.98 / 0.95 / 0.95 | 0.030 | 0.00016 | 0.984 | 5 | 0 |
| A | 5 | hw_b86c3cf3-1be | 1 | DISPUTE | verifier-glm-2, verifier-glm-3, verifier-glm-1 | 0.97 / 1.00 / 0.97 | 0.95 / 0.98 / 0.97 | 0.030 | 0.00020 | 0.983 | 5 | 0 |
| A | 5 | hw_b86c3cf3-1be | 2 | COLLUSION_RERUN | verifier-glm-2, verifier-glm-1, verifier-glm-3 | 1.00 / 0.97 / 0.98 | 0.98 / 0.97 / 0.97 | 0.030 | 0.00016 | 0.983 | 5 | 0 |
| A | 6 | hw_e06f0287-3d4 | 1 | DISPUTE | verifier-glm-1, verifier-glm-2, verifier-glm-3 | 1.00 / 1.00 / 0.98 | 0.98 / 0.98 / 0.97 | 0.020 | 0.00009 | 0.983 | 5 | 0 |
| A | 6 | hw_e06f0287-3d4 | 2 | COLLUSION_RERUN | verifier-glm-1, verifier-glm-2, verifier-glm-3 | 0.98 / 1.00 / 0.97 | 0.97 / 0.98 / 0.97 | 0.030 | 0.00016 | 0.983 | 5 | 0 |
| A | 7 | hw_27266010-c1b | 1 | DISPUTE | verifier-glm-2, verifier-glm-1, verifier-glm-3 | 1.00 / 1.00 / 0.97 | 0.98 / 0.98 / 0.97 | 0.030 | 0.00020 | 0.983 | 5 | 0 |
| A | 7 | hw_27266010-c1b | 2 | COLLUSION_RERUN | verifier-glm-2, verifier-glm-1, verifier-glm-3 | 0.97 / 0.98 / 1.00 | 0.97 / 0.97 / 0.98 | 0.030 | 0.00016 | 0.983 | 5 | 0 |
| A | 8 | hw_23f01d59-9ba | 1 | DISPUTE | verifier-glm-1, verifier-glm-2, verifier-glm-3 | 1.00 / 0.97 / 1.00 | 0.98 / 0.95 / 0.97 | 0.030 | 0.00020 | 1.000 | 5 | 0 |
| A | 8 | hw_23f01d59-9ba | 2 | COLLUSION_RERUN | verifier-glm-2, verifier-glm-3, verifier-glm-1 | 1.00 / 1.00 / 1.00 | 0.97 / 0.97 / 0.95 | 0.000 | 0.00000 | 1.000 | 5 | 0 |
| A | 9 | hw_cf14d773-401 | 1 | DISPUTE | verifier-glm-2, verifier-glm-1, verifier-glm-3 | 0.98 / 0.98 / 0.97 | 0.95 / 0.97 / 0.97 | 0.010 | 0.00002 | 0.983 | 5 | 0 |
| A | 9 | hw_cf14d773-401 | 2 | COLLUSION_RERUN | verifier-glm-1, verifier-glm-2, verifier-glm-3 | 0.97 / 0.98 / 1.00 | 0.97 / 0.97 / 0.98 | 0.030 | 0.00016 | 0.983 | 5 | 0 |
| A | 10 | hw_a5da86a2-464 | 1 | DISPUTE | verifier-glm-2, verifier-glm-1, verifier-glm-3 | 1.00 / 1.00 / 0.98 | 0.97 / 0.98 / 0.97 | 0.020 | 0.00009 | 1.000 | 5 | 0 |
| A | 10 | hw_a5da86a2-464 | 2 | COLLUSION_RERUN | verifier-glm-2, verifier-glm-3, verifier-glm-1 | 1.00 / 1.00 / 1.00 | 0.97 / 0.98 / 0.98 | 0.000 | 0.00000 | 1.000 | 5 | 0 |
| B | 1 | hw_1a4168dc-9d2 | 1 | DISPUTE | verifier-glm-3, verifier-glm-1, verifier-glm-2 | 0.55 / 0.55 / 0.60 | 0.95 / 0.97 / 0.97 | 0.050 | 0.00056 | 0.566 | 2.079305 | 2.920695 |
| B | 2 | hw_200cead7-e2c | 1 | DISPUTE | verifier-glm-3, verifier-glm-2, verifier-glm-1 | 0.60 / 0.62 / 0.55 | 0.98 / 0.97 / 0.97 | 0.070 | 0.00087 | 0.590 | 2.37861 | 2.62139 |
| B | 3 | hw_130079ac-35f | 1 | DISPUTE | verifier-glm-1, verifier-glm-2, verifier-glm-3 | 0.50 / 0.62 / 0.33 | 0.95 / 0.97 / 0.97 | 0.290 | 0.01416 | 0.484 | 1.047135 | 3.952865 |
| B | 4 | hw_47421503-368 | 1 | DISPUTE | verifier-glm-2, verifier-glm-1, verifier-glm-3 | 0.55 / 0.50 / 0.55 | 0.97 / 0.97 / 0.97 | 0.050 | 0.00056 | 0.533 | 1.667455 | 3.332545 |
| B | 5 | hw_7ed63bb5-140 | 1 | DISPUTE | verifier-glm-3, verifier-glm-2, verifier-glm-1 | 0.65 / 0.55 / 0.62 | 0.95 / 0.95 / 0.97 | 0.100 | 0.00176 | 0.607 | 2.586235 | 2.413765 |
| B | 6 | hw_9f7c89f8-08c | 1 | DISPUTE | verifier-glm-2, verifier-glm-3, verifier-glm-1 | 0.62 / 0.55 / 0.55 | 0.97 / 0.95 / 0.97 | 0.070 | 0.00109 | 0.574 | 2.17115 | 2.82885 |
| B | 7 | hw_98f28e4e-b95 | 1 | DISPUTE | verifier-glm-1, verifier-glm-2, verifier-glm-3 | 0.65 / 0.62 / 0.65 | 0.97 / 0.97 / 0.98 | 0.030 | 0.00020 | 0.616 | 2.70497 | 2.29503 |
| B | 7 | hw_98f28e4e-b95 | 2 | COLLUSION_RERUN | verifier-glm-2, verifier-glm-1, verifier-glm-3 | 0.60 / 0.65 / 0.60 | 0.97 / 0.95 / 0.97 | 0.050 | 0.00056 | 0.616 | 2.70497 | 2.29503 |
| B | 8 | hw_a24e4781-498 | 1 | DISPUTE | verifier-glm-1, verifier-glm-2, verifier-glm-3 | 0.50 / 0.65 / 0.65 | 0.97 / 0.95 / 0.95 | 0.150 | 0.00500 | 0.599 | 2.487965 | 2.512035 |
| B | 9 | hw_8f27c9fd-391 | 1 | DISPUTE | verifier-glm-1, verifier-glm-3, verifier-glm-2 | 0.60 / 0.62 / 0.62 | 0.97 / 0.97 / 0.95 | 0.020 | 0.00009 | 0.613 | 2.66688 | 2.33312 |
| B | 9 | hw_8f27c9fd-391 | 2 | COLLUSION_RERUN | verifier-glm-3, verifier-glm-1, verifier-glm-2 | 0.62 / 0.62 / 0.60 | 0.97 / 0.97 / 0.97 | 0.020 | 0.00009 | 0.613 | 2.66688 | 2.33312 |
| B | 10 | hw_df7256d7-935 | 1 | DISPUTE | verifier-glm-2, verifier-glm-1, verifier-glm-3 | 0.60 / 0.60 / 0.60 | 0.97 / 0.95 / 0.95 | 0.000 | 0.00000 | 0.566 | 2.07538 | 2.92462 |
| B | 10 | hw_df7256d7-935 | 2 | COLLUSION_RERUN | verifier-glm-1, verifier-glm-3, verifier-glm-2 | 0.55 / 0.50 / 0.65 | 0.98 / 0.97 / 0.95 | 0.150 | 0.00389 | 0.566 | 2.07538 | 2.92462 |
| C | 1 | hw_e295dda6-f55 | 1 | DISPUTE | verifier-glm-2, verifier-glm-1, verifier-glm-3 | 0.65 / 0.63 / 0.65 | 0.95 / 0.97 / 0.95 | 0.020 | 0.00009 | 0.630 | 2.873185 | 2.126815 |
| C | 1 | hw_e295dda6-f55 | 2 | COLLUSION_RERUN | verifier-glm-3, verifier-glm-1, verifier-glm-2 | 0.62 / 0.62 / 0.65 | 0.95 / 0.97 / 0.97 | 0.030 | 0.00020 | 0.630 | 2.873185 | 2.126815 |
| C | 2 | hw_ba5cc38d-a2d | 1 | DISPUTE | verifier-glm-1, verifier-glm-2, verifier-glm-3 | 0.63 / 0.65 / 0.62 | 0.97 / 0.95 / 0.95 | 0.030 | 0.00016 | 0.640 | 3.00076 | 1.99924 |
| C | 2 | hw_ba5cc38d-a2d | 2 | COLLUSION_RERUN | verifier-glm-1, verifier-glm-2, verifier-glm-3 | 0.65 / 0.62 / 0.65 | 0.95 / 0.95 / 0.97 | 0.030 | 0.00020 | 0.640 | 3.00076 | 1.99924 |
| C | 3 | hw_09ac2ca1-458 | 1 | DISPUTE | verifier-glm-2, verifier-glm-3, verifier-glm-1 | 0.60 / 0.65 / 0.65 | 0.95 / 0.95 / 0.95 | 0.050 | 0.00056 | 0.633 | 2.91374 | 2.08626 |
| C | 4 | hw_01afb33b-01a | 1 | DISPUTE | verifier-glm-1, verifier-glm-3, verifier-glm-2 | 0.67 / 0.60 / 0.65 | 0.95 / 0.97 / 0.95 | 0.070 | 0.00087 | 0.640 | 2.998145 | 2.001855 |
| C | 5 | hw_e3a57c23-b84 | 1 | DISPUTE | verifier-glm-1, verifier-glm-3, verifier-glm-2 | 0.55 / 0.62 / 0.60 | 0.97 / 0.97 / 0.95 | 0.070 | 0.00087 | 0.590 | 2.371775 | 2.628225 |
| C | 6 | hw_6295ba5d-c18 | 1 | DISPUTE | verifier-glm-1, verifier-glm-3, verifier-glm-2 | 0.55 / 0.62 / 0.67 | 0.95 / 0.95 / 0.95 | 0.120 | 0.00242 | 0.613 | 2.66267 | 2.33733 |
| C | 7 | hw_3d3debb2-ea4 | 1 | DISPUTE | verifier-glm-3, verifier-glm-1, verifier-glm-2 | 0.62 / 0.62 / 0.62 | 0.97 / 0.97 / 0.95 | 0.000 | 0.00000 | 0.617 | 2.70754 | 2.29246 |
| C | 7 | hw_3d3debb2-ea4 | 2 | COLLUSION_RERUN | verifier-glm-2, verifier-glm-3, verifier-glm-1 | 0.60 / 0.60 / 0.65 | 0.97 / 0.97 / 0.97 | 0.050 | 0.00056 | 0.617 | 2.70754 | 2.29246 |
| C | 8 | hw_ae804ba0-aea | 1 | DISPUTE | verifier-glm-2, verifier-glm-3, verifier-glm-1 | 0.65 / 0.62 / 0.63 | 0.97 / 0.96 / 0.95 | 0.030 | 0.00016 | 0.574 | 2.170415 | 2.829585 |
| C | 8 | hw_ae804ba0-aea | 2 | COLLUSION_RERUN | verifier-glm-2, verifier-glm-1, verifier-glm-3 | 0.55 / 0.55 / 0.62 | 0.95 / 0.95 / 0.97 | 0.070 | 0.00109 | 0.574 | 2.170415 | 2.829585 |
| C | 9 | hw_18b57ed0-998 | 1 | DISPUTE | verifier-glm-2, verifier-glm-3, verifier-glm-1 | 0.55 / 0.65 / 0.60 | 0.95 / 0.95 / 0.95 | 0.100 | 0.00167 | 0.600 | 2.49996 | 2.50004 |
| C | 10 | hw_5c1613c9-fb5 | 1 | DISPUTE | verifier-glm-1, verifier-glm-2, verifier-glm-3 | 0.55 / 0.60 / 0.62 | 0.95 / 0.97 / 0.97 | 0.070 | 0.00087 | 0.590 | 2.37831 | 2.62169 |
