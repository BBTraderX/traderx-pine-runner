# traderx-pine-runner

Runs [Pine Script®](https://www.tradingview.com/pine-script-docs/) v5/v6 on [Hyperliquid](https://hyperliquid.xyz) candles. It is the service behind Pine Script strategies on [BB TraderX](https://www.bbtraderx.com): users paste a script, see its plots, backtest it on any coin, and run it live.

It is built on [PineTS](https://github.com/LuxAlgo/PineTS) by LuxAlgo, and like PineTS it is licensed under the **GNU AGPL-3.0**. If you use this service over a network, you are entitled to its source code, which is this repository.

## API

`POST /v1/run` with `Authorization: Bearer $RUNNER_TOKEN`

```json
{ "source": "//@version=5\nstrategy(\"EMA Cross\")\n...", "coin": "ETH", "interval": "1h", "bars": 2000, "inputs": { "Fast": 12 } }
```

Instead of `coin`, send `candles` (oldest first, `{ openTime, open, high, low, close, volume }`, at most 5,000).

The response has:

- `declaration`: `"strategy"` or `"indicator"`
- `inputs`: every `input.*` in the script, with defaults and limits
- `plots`: each plot's series by title
- `alerts`: `alert()` and `alertcondition()` events on every bar
- `strategy`: for `strategy()` scripts, the trade list and net profit from the PineTS broker emulator
- `signals`: the strategy's position changes as `entry-long`, `exit-long`, `entry-short` and `exit-short` (TraderX's signal names), each with its decision bar and that bar's open time

Errors in the script come back as `422` with a readable `error`.

`GET /healthz` returns `{ "ok": true }`.

## Limits

- Each run happens in its own worker thread, stopped after `RUN_TIMEOUT_MS` (15s) or `RUN_HEAP_MB` (256 MB).
- At most `MAX_CONCURRENT` (4) runs at once; extra requests get `429`.
- Hyperliquid keeps only the latest 5,000 candles per coin and interval.

## Running

```sh
npm ci
RUNNER_TOKEN=change-me npm start   # listens on PORT, default 8787
npm test
```

Or `docker build -t traderx-pine-runner .` and run it with `RUNNER_TOKEN` set.

## License

GNU Affero General Public License v3.0. See [LICENSE](LICENSE). Pine Script® is a trademark of TradingView, Inc. This project is not affiliated with TradingView.
