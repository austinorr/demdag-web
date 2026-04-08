const getRelativeMousePosition = (event, target) => {
  target = target || event.target;
  const { left, top } = target.getBoundingClientRect();

  return {
    x: event.clientX - left,
    y: event.clientY - top,
  };
};

// assumes target or event.target is canvas
export const getNoPaddingNoBorderCanvasRelativeMousePosition = (event, target) => {
  target = target || event.target;
  let { x, y } = getRelativeMousePosition(event, target);

  x = (x * target.width) / target.clientWidth;
  y = (y * target.height) / target.clientHeight;

  return { x, y };
};


