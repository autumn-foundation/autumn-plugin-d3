// Demo: a custom chart kind. `sparkline` draws a small line with no axes.
// It runs after d3_script(), so window.AutumnD3 exists.
AutumnD3.register("sparkline", ({ d3, svg, width, height, data, color }) => {
  const x = d3.scaleLinear([0, data.length - 1], [4, width - 4]);
  const y = d3.scaleLinear(d3.extent(data), [height - 4, 4]);
  const line = d3.line((_, i) => x(i), y).curve(d3.curveMonotoneX);
  svg
    .append("path")
    .attr("d", line(data))
    .style("fill", "none")
    .style("stroke", color(0))
    .style("stroke-width", 2);
  svg
    .append("circle")
    .attr("cx", x(data.length - 1))
    .attr("cy", y(data.at(-1)))
    .attr("r", 4)
    .style("fill", color(0));
});
