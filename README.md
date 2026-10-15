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

- `declaration`: `"strategy"` or `"indicator"`, plus its `title` and whether it draws on the price pane (`overlay`)
- `inputs`: every `input.*` in the script, with defaults and limits
- `plots`: each plot's series by title
- `alerts`: `alert()` and `alertcondition()` events on every bar
- `strategy`: for `strategy()` scripts, the trade list and net profit from the PineTS broker emulator
- `signals`: the strategy's position changes as `entry-long`, `exit-long`, `entry-short` and `exit-short` (TraderX's signal names), each with its decision bar and that bar's open time

### Conditions

Most indicators have no trading rules. Send `conditions` to set them: for any of `entry-long`, `exit-long`, `entry-short`, `exit-short`, a list of rules that must all hold on a bar.

```json
{ "conditions": {
    "entry-long":  [{ "left": "plot:Fast", "op": "crosses_above", "right": { "series": "plot:Slow" } }],
    "entry-short": [{ "left": "plot:RSI", "op": "crosses_below", "right": { "value": 70 } }],
    "exit-long":   [{ "left": "alert:Sell", "op": "fires" }] } }
```

Series are `plot:<title>` (lines; an untitled plot is `Plot 1`, `Plot 2`…) and `price:open|high|low|close|volume`. With `fires`, an event from `events` in the response: `shape:<title>` (plotshape/plotchar arrows and characters), `background:<title>` (bgcolor shading), `label:<text>` (label.new; Pine keeps only the newest 50 by default, so labels cover recent history) and `alert:<alertcondition title>`. Operators: `crosses_above`, `crosses_below`, `above`, `below`, `fires`. The rules are played through one position (enter when flat, long wins a tie; exit on the side's exit rules; the opposite entry reverses), so `signals` holds only position changes, each on the bar its rules held. `signalSource` says whether signals came from `conditions` or the script's `strategy` calls.

### AI mode: `POST /v1/search`

Same body as `/v1/run` (without `conditions`). Finds the conditions that trade the indicator best, the way BB TraderX AI Studio's Find does:

1. Runs the script at a few values of its first two numeric inputs (half to double the default).
2. At each, builds every sensible rule from its output (line crosses, price vs line, oscillator levels, zero crosses, its arrows, labels and alerts, trend filters) and tests flips and one-sided trades with every exit, at Hyperliquid fees, filling at the next open.
3. Keeps only sets with at least 12 trades that made money overall and in at least 3 of 4 periods of the first 80% of history.
4. Grades the best on the last 20%, which the search never saw, against holding the coin, and returns the top five with their `conditions` and `inputs`.

Stops at `SEARCH_TIMEOUT_MS` (120s). Its numbers are the search's own simulation; backtest the pick for the real figures.

Errors in the script come back as `422` with a readable `error`.

`GET /healthz` returns `{ "ok": true }`.

## Limits

- Each run happens in its own worker thread, stopped after `RUN_TIMEOUT_MS` (30s) or `RUN_HEAP_MB` (512 MB).
- At most `MAX_CONCURRENT` (3) runs at once; extra requests get `429`.
- Hyperliquid keeps only the latest 5,000 candles per coin and interval.

## Other timeframes and symbols

`request.security` loads any other timeframe or Hyperliquid coin from Hyperliquid (`syminfo.tickerid` is the run's coin). Timeframes Hyperliquid has no candles for, such as 10, 45 or 360 (6h), are built from a smaller one that divides them. A run may load at most 24 of them, and each is limited to its latest 5,000 candles, so a 1-minute series reaches back about 3.5 days.

Two PineTS limits to know:

- Call `request.security` directly, not from inside your own function that is called more than once: PineTS loses the result of the second call. Wrap the expression in a function instead (`request.security(syminfo.tickerid, "240", myValues())`).
- A lower timeframe that does not divide the chart's (45 on a 1h chart) has a value only on bars where a whole 45-minute bar fits inside the chart bar.

## Running

```sh
npm ci
RUNNER_TOKEN=change-me npm start   # listens on PORT, default 8787
npm test
```

Or `docker build -t traderx-pine-runner .` and run it with `RUNNER_TOKEN` set.

## License

GNU Affero General Public License v3.0. See [LICENSE](LICENSE). Pine Script® is a trademark of TradingView, Inc. This project is not affiliated with TradingView.
