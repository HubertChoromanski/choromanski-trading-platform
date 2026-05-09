from tvDatafeed import TvDatafeed, Interval

import pandas as pd
import numpy as np

from dash import Dash, dcc, html
from dash.dependencies import Input, Output, State

import plotly.graph_objects as go
from plotly.subplots import make_subplots

# =========================================================
# APP
# =========================================================

app = Dash(__name__)

# =========================================================
# TV
# =========================================================

tv = TvDatafeed()

# =========================================================
# SETTINGS
# =========================================================

DEFAULT_SYMBOL = "SOLUSDT"
DEFAULT_EXCHANGE = "BINANCE"

# =========================================================
# GAUSSIAN
# =========================================================

def gauss(x, h):

    return np.exp(
        -(x ** 2) / (2 * h * h)
    )

# =========================================================
# HEIKEN ASHI
# =========================================================

def heiken_ashi(df):

    ha = pd.DataFrame(index=df.index)

    ha["close"] = (
        df["open"] +
        df["high"] +
        df["low"] +
        df["close"]
    ) / 4

    ha_open = [df["open"].iloc[0]]

    for i in range(1, len(df)):

        ha_open.append(
            (
                ha_open[i - 1] +
                ha["close"].iloc[i - 1]
            ) / 2
        )

    ha["open"] = ha_open

    ha["high"] = pd.concat([
        df["high"],
        ha["open"],
        ha["close"]
    ], axis=1).max(axis=1)

    ha["low"] = pd.concat([
        df["low"],
        ha["open"],
        ha["close"]
    ], axis=1).min(axis=1)

    return ha

# =========================================================
# NWE
# =========================================================

def calculate_nwe(close, bandwidth=8):

    coefs = np.array([
        gauss(i, bandwidth)
        for i in range(500)
    ])

    den = np.sum(coefs)

    result = []

    for idx in range(len(close)):

        total = 0

        max_range = min(idx + 1, 500)

        for i in range(max_range):

            total += (
                close[idx - i] *
                coefs[i]
            )

        result.append(total / den)

    return np.array(result)

# =========================================================
# ATR
# =========================================================

def calculate_atr(df, period=14):

    high_low = df["high"] - df["low"]

    high_close = np.abs(
        df["high"] - df["close"].shift()
    )

    low_close = np.abs(
        df["low"] - df["close"].shift()
    )

    ranges = pd.concat([
        high_low,
        high_close,
        low_close
    ], axis=1)

    tr = ranges.max(axis=1)

    atr = tr.rolling(period).mean()

    return atr

# =========================================================
# STRATEGY
# =========================================================

def strategy_engine(
    df,
    bandwidth,
    mult,
    atr_len,
    atr_mult
):

    # =====================================================
    # HEIKEN ASHI
    # =====================================================

    ha = heiken_ashi(df)

    df["ha_open"] = ha["open"]
    df["ha_high"] = ha["high"]
    df["ha_low"] = ha["low"]
    df["ha_close"] = ha["close"]

    # =====================================================
    # NWE
    # =====================================================

    df["nwe"] = calculate_nwe(
        df["ha_close"],
        bandwidth
    )

    mae = (
        np.abs(
            df["ha_close"] -
            df["nwe"]
        )
        .rolling(499)
        .mean()
    ) * mult

    df["upper"] = df["nwe"] + mae
    df["lower"] = df["nwe"] - mae

    # =====================================================
    # ATR
    # =====================================================

    df["atr"] = calculate_atr(
        df,
        atr_len
    )

    # =====================================================
    # SIGNALS
    # =====================================================

    df["longSignal"] = (

        (df["ha_close"] < df["lower"]) &

        (
            df["ha_close"].shift(1) >=
            df["lower"].shift(1)
        )
    )

    df["shortSignal"] = (

        (df["ha_close"] > df["upper"]) &

        (
            df["ha_close"].shift(1) <=
            df["upper"].shift(1)
        )
    )

    # =====================================================
    # HA COLORS
    # =====================================================

    df["haBull"] = (
        df["ha_close"] >
        df["ha_open"]
    )

    df["haBear"] = (
        df["ha_close"] <
        df["ha_open"]
    )

    # =====================================================
    # STATE ENGINE
    # =====================================================

    waitLong = False
    waitShort = False

    longSetup = False
    shortSetup = False

    longTrigger = np.nan
    shortTrigger = np.nan

    longSL = np.nan
    shortSL = np.nan

    # =====================================================
    # STORAGE
    # =====================================================

    longs = []
    shorts = []

    longSLs = []
    shortSLs = []

    # =====================================================
    # LOOP
    # =====================================================

    for i in range(len(df)):

        row = df.iloc[i]

        # =================================================
        # WAIT
        # =================================================

        if row["longSignal"] and not longSetup:
            waitLong = True

        if row["shortSignal"] and not shortSetup:
            waitShort = True

        # =================================================
        # BENCHMARK
        # =================================================

        longBenchmark = (
            waitLong and
            row["haBull"]
        )

        shortBenchmark = (
            waitShort and
            row["haBear"]
        )

        # =================================================
        # LONG BENCHMARK
        # =================================================

        if longBenchmark:

            midpoint = (
                row["open"] +
                row["close"]
            ) / 2

            longTrigger = row["high"]

            longSL = (
                midpoint -
                (row["atr"] * atr_mult)
            )

            longSetup = True

            waitLong = False

        # =================================================
        # SHORT BENCHMARK
        # =================================================

        if shortBenchmark:

            midpoint = (
                row["open"] +
                row["close"]
            ) / 2

            shortTrigger = row["low"]

            shortSL = (
                midpoint +
                (row["atr"] * atr_mult)
            )

            shortSetup = True

            waitShort = False

        # =================================================
        # ENTRY
        # =================================================

        longTriggered = (
            longSetup and
            row["high"] >= longTrigger
        )

        shortTriggered = (
            shortSetup and
            row["low"] <= shortTrigger
        )

        # =================================================
        # INVALIDATION
        # =================================================

        longInvalid = (
            longSetup and
            row["low"] <= longSL
        )

        shortInvalid = (
            shortSetup and
            row["high"] >= shortSL
        )

        # =================================================
        # LONG
        # =================================================

        if longTriggered:

            longs.append(i)

            longSetup = False

        # =================================================
        # SHORT
        # =================================================

        if shortTriggered:

            shorts.append(i)

            shortSetup = False

        # =================================================
        # FAIL
        # =================================================

        if longInvalid and not longTriggered:
            longSetup = False

        if shortInvalid and not shortTriggered:
            shortSetup = False

        # =================================================
        # STORE
        # =================================================

        longSLs.append(longSL)
        shortSLs.append(shortSL)

    # =====================================================
    # SAVE
    # =====================================================

    df["longSL"] = longSLs
    df["shortSL"] = shortSLs

    return {

        "df": df,

        "longs": longs,

        "shorts": shorts
    }

# =========================================================
# LAYOUT
# =========================================================

app.layout = html.Div([

    # =====================================================
    # HEADER
    # =====================================================

    html.Div([

        html.Div([

            html.H1(
                "Hubert Institutional Terminal",
                style={
                    "margin": "0",
                    "fontSize": "38px",
                    "fontWeight": "700"
                }
            ),

            html.Div(
                "Professional Nadaraya Execution Engine",
                style={
                    "color": "#666",
                    "marginTop": "8px"
                }
            )

        ]),

        # =================================================
        # CONTROLS
        # =================================================

        html.Div([

            dcc.Input(

                id="symbol",

                value="SOLUSDT",

                type="text",

                style={
                    "background": "#111",
                    "color": "white",
                    "border": "1px solid #333",
                    "padding": "10px",
                    "width": "120px"
                }
            ),

            dcc.Dropdown(

                id="timeframe",

                options=[

                    {
                        "label": "1m",
                        "value": "1m"
                    },

                    {
                        "label": "5m",
                        "value": "5m"
                    },

                    {
                        "label": "15m",
                        "value": "15m"
                    },

                    {
                        "label": "1H",
                        "value": "1h"
                    },

                    {
                        "label": "4H",
                        "value": "4h"
                    }
                ],

                value="15m",

                style={
                    "width": "120px",
                    "color": "black"
                }
            ),

            dcc.Input(

                id="bandwidth",

                value=8,

                type="number",

                step=0.1,

                style={
                    "width": "90px",
                    "padding": "10px",
                    "background": "#111",
                    "color": "white",
                    "border": "1px solid #333"
                }
            ),

            dcc.Input(

                id="mult",

                value=3,

                type="number",

                step=0.1,

                style={
                    "width": "90px",
                    "padding": "10px",
                    "background": "#111",
                    "color": "white",
                    "border": "1px solid #333"
                }
            ),

            dcc.Input(

                id="atr",

                value=1.2,

                type="number",

                step=0.1,

                style={
                    "width": "90px",
                    "padding": "10px",
                    "background": "#111",
                    "color": "white",
                    "border": "1px solid #333"
                }
            )

        ], style={

            "display": "flex",

            "gap": "10px",

            "alignItems": "center"
        })

    ], style={

        "display": "flex",

        "justifyContent": "space-between",

        "padding": "20px",

        "backgroundColor": "#0b0b0b",

        "borderBottom": "1px solid #1f1f1f"
    }),

    # =====================================================
    # GRAPH
    # =====================================================

    dcc.Graph(

        id="chart",

        config={

            "scrollZoom": True,

            "displaylogo": False,

            "responsive": True,

            "modeBarButtonsToRemove": [

                "select2d",
                "lasso2d"
            ]
        },

        style={
            "height": "92vh"
        }
    ),

    # =====================================================
    # AUTO REFRESH
    # =====================================================

    dcc.Interval(

        id="refresh",

        interval=20 * 1000,

        n_intervals=0
    )

], style={

    "backgroundColor": "#000000",

    "color": "white",

    "height": "100vh"
})

# =========================================================
# CALLBACK
# =========================================================

@app.callback(

    Output("chart", "figure"),

    Input("refresh", "n_intervals"),

    State("symbol", "value"),

    State("timeframe", "value"),

    State("bandwidth", "value"),

    State("mult", "value"),

    State("atr", "value")
)

def update_chart(

    n,

    symbol,

    timeframe,

    bandwidth,

    mult,

    atr_mult
):

    # =====================================================
    # TF MAP
    # =====================================================

    tf_map = {

        "1m": Interval.in_1_minute,

        "5m": Interval.in_5_minute,

        "15m": Interval.in_15_minute,

        "1h": Interval.in_1_hour,

        "4h": Interval.in_4_hour
    }

    # =====================================================
    # DOWNLOAD
    # =====================================================

    df = tv.get_hist(

        symbol=symbol,

        exchange=DEFAULT_EXCHANGE,

        interval=tf_map[timeframe],

        n_bars=10000
    )

    if df is None:

        return go.Figure()

    df = df.reset_index()

    # =====================================================
    # STRATEGY
    # =====================================================

    result = strategy_engine(

        df,

        bandwidth,

        mult,

        14,

        atr_mult
    )

    df = result["df"]

    longs = result["longs"]

    shorts = result["shorts"]

    # =====================================================
    # FIGURE
    # =====================================================

    fig = make_subplots(

        rows=1,
        cols=1,

        shared_xaxes=True
    )

    # =====================================================
    # HEIKEN ASHI
    # =====================================================

    fig.add_trace(

        go.Candlestick(

            x=df["datetime"],

            open=df["ha_open"],

            high=df["ha_high"],

            low=df["ha_low"],

            close=df["ha_close"],

            name="HA",

            increasing_line_color="#ffffff",

            increasing_fillcolor="#ffffff",

            decreasing_line_color="#000000",

            decreasing_fillcolor="#000000",

            whiskerwidth=0.5
        )
    )

    # =====================================================
    # UPPER
    # =====================================================

    fig.add_trace(

        go.Scatter(

            x=df["datetime"],

            y=df["upper"],

            mode="lines",

            name="Upper",

            line=dict(

                color="#ffffff",

                width=2
            )
        )
    )

    # =====================================================
    # LOWER
    # =====================================================

    fig.add_trace(

        go.Scatter(

            x=df["datetime"],

            y=df["lower"],

            mode="lines",

            name="Lower",

            line=dict(

                color="#555555",

                width=2
            )
        )
    )

    # =====================================================
    # LONGS
    # =====================================================

    fig.add_trace(

        go.Scatter(

            x=df.iloc[longs]["datetime"],

            y=df.iloc[longs]["low"],

            mode="markers",

            name="LONG",

            marker=dict(

                color="#ffffff",

                size=16,

                symbol="triangle-up"
            )
        )
    )

    # =====================================================
    # SHORTS
    # =====================================================

    fig.add_trace(

        go.Scatter(

            x=df.iloc[shorts]["datetime"],

            y=df.iloc[shorts]["high"],

            mode="markers",

            name="SHORT",

            marker=dict(

                color="#000000",

                size=16,

                symbol="triangle-down",

                line=dict(
                    color="#ffffff",
                    width=1
                )
            )
        )
    )

    # =====================================================
    # LONG SL
    # =====================================================

    fig.add_trace(

        go.Scatter(

            x=df["datetime"],

            y=df["longSL"],

            mode="lines",

            name="LONG SL",

            line=dict(

                color="#999999",

                dash="dot",

                width=1
            )
        )
    )

    # =====================================================
    # SHORT SL
    # =====================================================

    fig.add_trace(

        go.Scatter(

            x=df["datetime"],

            y=df["shortSL"],

            mode="lines",

            name="SHORT SL",

            line=dict(

                color="#444444",

                dash="dot",

                width=1
            )
        )
    )

    # =====================================================
    # LAYOUT
    # =====================================================

    fig.update_layout(

        template="plotly_dark",

        paper_bgcolor="#000000",

        plot_bgcolor="#000000",

        dragmode="pan",

        hovermode="x unified",

        xaxis_rangeslider_visible=False,

        autosize=True,

        height=950,

        margin=dict(

            l=10,
            r=10,
            t=10,
            b=10
        ),

        font=dict(

            family="Arial",

            color="white"
        ),

        legend=dict(

            bgcolor="rgba(0,0,0,0)",

            font=dict(
                size=14
            )
        ),

        xaxis=dict(

            showgrid=True,

            gridcolor="#111111",

            zeroline=False,

            fixedrange=False,

            rangeslider_visible=False
        ),

        yaxis=dict(

            showgrid=True,

            gridcolor="#111111",

            zeroline=False,

            fixedrange=False
        )
    )

    return fig

# =========================================================
# START
# =========================================================

if __name__ == "__main__":

    app.run(debug=True)