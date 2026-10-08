// E2E fixture: custom chart kinds.
AutumnD3.register("dots", (ctx) => {
  ctx.svg
    .selectAll("circle")
    .data(ctx.data)
    .join("circle")
    .attr("class", "custom-dot")
    .attr("cx", (_, i) => ((i + 1) * ctx.width) / (ctx.data.length + 1))
    .attr("cy", ctx.height / 2)
    .attr("r", 5)
    .style("fill", ctx.color(0));
});
AutumnD3.register("broken", () => {
  throw new Error("broken draw");
});
