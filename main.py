from tvDatafeed import TvDatafeed, Interval
print(trades_df.tail(30))

# =====================================================
# CHART
# =====================================================

fig = go.Figure()

# candles

fig.add_trace(go.Candlestick(
    x=df['datetime'],
    open=df['ha_open'],
    high=df['ha_high'],
    low=df['ha_low'],
    close=df['ha_close'],
    name='HA'
))

# envelope

fig.add_trace(go.Scatter(
    x=df['datetime'],
    y=df['upper'],
    mode='lines',
    name='Upper'
))

fig.add_trace(go.Scatter(
    x=df['datetime'],
    y=df['lower'],
    mode='lines',
    name='Lower'
))

fig.add_trace(go.Scatter(
    x=df['datetime'],
    y=df['nwe'],
    mode='lines',
    name='NWE'
))

# signals

for trade in trades:

    color = 'green'

    if 'SHORT' in trade['type']:
        color = 'red'

    fig.add_trace(go.Scatter(
        x=[trade['time']],
        y=[trade['price']],
        mode='markers+text',
        text=[trade['type']],
        textposition='top center',
        marker=dict(size=10, color=color),
        name=trade['type']
    ))

# layout

fig.update_layout(
    title='Nadaraya Backtest',
    xaxis_rangeslider_visible=False,
    height=900
)

fig.show()