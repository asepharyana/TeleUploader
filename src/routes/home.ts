export const handleHome = async (): Promise<Response> => {
  const html = await Bun.file('src/home.html').text();
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
    },
  });
};
