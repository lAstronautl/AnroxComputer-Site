# frozen_string_literal: true

require "json"

# Convert wiki-style links such as [[Post Title]] into Markdown links and
# image embeds such as ![[image.png]] into Markdown images.
module WikiLinks
  DATE_PREFIX = /\A\d{2,4}-\d{1,2}-\d{1,2}-/
  IMAGE_EXT = /\.(?:avif|gif|jpe?g|png|svg|webp)\z/i
  CANVAS_EXT = /\.canvas\z/i
  WIKI_IMAGE = /!\[\[([^\]\n]+)\]\]/
  WIKI_LINK = /(?<!!)\[\[([^\]\n]+)\]\]/

  module_function

  def post_index(site)
    site.posts.docs.each_with_object({}) do |post, index|
      title = post.data["title"].to_s.strip
      index[normalize(title)] = post unless title.empty?

      basename = File.basename(post.path, ".*").sub(DATE_PREFIX, "")
      index[normalize(basename)] ||= post unless basename.empty?
    end
  end

  def normalize(value)
    value.to_s.strip.downcase
  end

  def normalize_path(value)
    normalize(value).tr("\\", "/").sub(%r!\A/+!, "")
  end

  def image_index(site)
    @image_indexes ||= {}
    @image_indexes[site.source] ||= begin
      files = Dir.glob(File.join(site.source, "**", "*")).select do |path|
        File.file?(path) && File.extname(path).match?(IMAGE_EXT)
      end

      source = site.source.tr("\\", "/")

      files.each_with_object({}) do |path, index|
        relative_path = path.tr("\\", "/").sub(%r!\A#{Regexp.escape(source)}/!, "")
        next if relative_path.start_with?("_site/", ".git/")

        index[normalize_path(relative_path)] ||= relative_path
        index[normalize(File.basename(relative_path))] ||= relative_path
      end
    end
  end

  def canvas_index(site)
    @canvas_indexes ||= {}
    @canvas_indexes[site.source] ||= begin
      files = Dir.glob(File.join(site.source, "**", "*.canvas")).select do |path|
        File.file?(path)
      end

      source = site.source.tr("\\", "/")

      files.each_with_object({}) do |path, index|
        relative_path = path.tr("\\", "/").sub(%r!\A#{Regexp.escape(source)}/!, "")
        next if relative_path.start_with?("_site/", ".git/")

        basename = File.basename(relative_path)
        title = File.basename(relative_path, ".canvas")

        index[normalize_path(relative_path)] ||= relative_path
        index[normalize_path(basename)] ||= relative_path
        index[normalize(title)] ||= relative_path
      end
    end
  end

  def markdown_link(site, text, post)
    url = [site.config["baseurl"], post.url].join.sub(%r!//+!, "/")
    "[#{text}](#{url})"
  end

  def markdown_image(site, target)
    alt = File.basename(target, ".*")
    local_source = local_image_source(site, target)
    return "![#{alt}](#{local_source})" if local_source

    sources = cdn_image_sources(site, target)
    return "![[#{target}]]" if sources.empty?
    return "![#{alt}](#{sources.first})" if sources.one?

    html_image(alt, sources)
  end

  def canvas_embed(site, target)
    relative_path = canvas_source(site, target)
    return unless relative_path

    full_path = File.join(site.source, relative_path)
    data = JSON.parse(File.read(full_path, encoding: "UTF-8"))
    title = File.basename(relative_path, ".canvas")
    escaped_title = escape_html(title)
    json = json_for_script(data)
    baseurl = escape_html(site.config["baseurl"].to_s)

    <<~HTML

      <div class="obsidian-canvas-embed">
        <div class="obsidian-canvas-embed-title">#{escaped_title}</div>
        <div class="obsidian-canvas" data-baseurl="#{baseurl}">
          <script type="application/json" class="obsidian-canvas-data">#{json}</script>
          <div class="obsidian-canvas-toolbar" aria-label="Canvas controls">
            <button type="button" data-canvas-action="zoom-out" aria-label="Zoom out"><i class="fas fa-minus"></i></button>
            <button type="button" data-canvas-action="reset" aria-label="Reset view"><i class="fas fa-expand"></i></button>
            <button type="button" data-canvas-action="zoom-in" aria-label="Zoom in"><i class="fas fa-plus"></i></button>
          </div>
          <div class="obsidian-canvas-stage">
            <svg class="obsidian-canvas-edges" aria-hidden="true"></svg>
            <div class="obsidian-canvas-nodes"></div>
          </div>
        </div>
      </div>

    HTML
  rescue JSON::ParserError => e
    Jekyll.logger.warn "WikiLinks:", "Skipping canvas embed #{target}: #{e.message}"
    nil
  end

  def canvas_source(site, target)
    target = target.strip
    return unless target.match?(CANVAS_EXT)

    canvas_index(site)[normalize_path(target)] ||
      canvas_index(site)[normalize_path(File.basename(target))] ||
      canvas_index(site)[normalize(File.basename(target, ".canvas"))]
  end

  def local_image_source(site, target)
    target = target.strip
    return target if target.match?(%r!\Ahttps?://!i)

    local_path = image_index(site)[normalize_path(target)] ||
      image_index(site)[normalize(File.basename(target))]

    return unless local_path

    [site.config["baseurl"], local_path].join("/").sub(%r!//+!, "/")
  end

  def cdn_image_sources(site, target)
    cdn = site.config["cdn"].to_s.sub(%r!/+\z!, "")
    return [] if cdn.empty?

    target = target.strip.sub(%r!\A/+!, "")
    return ["#{cdn}/#{target}"] if target.include?("/")

    cdn_image_dirs(site).map do |dir|
      path = [dir, target].reject(&:empty?).join("/")
      "#{cdn}/#{path}"
    end.uniq
  end

  def cdn_image_dirs(site)
    config = site.config.dig("wiki_links", "cdn_image_dirs")
    dirs = Array(config).map { |dir| dir.to_s.strip.sub(%r!\A/+!, "").sub(%r!/+\z!, "") }
    dirs.empty? ? [""] : dirs
  end

  def html_image(alt, sources)
    escaped_alt = escape_html(alt)
    escaped_sources = sources.map { |source| escape_html(source) }
    onerror = "this.dataset.i=(+this.dataset.i||0)+1;" \
      "var s=this.dataset.srcs.split('|');" \
      "if(this.dataset.i<s.length){this.src=s[this.dataset.i];}" \
      "else{this.onerror=null;}"

    "<img src=\"#{escaped_sources.first}\" alt=\"#{escaped_alt}\" " \
      "data-srcs=\"#{escaped_sources.join('|')}\" onerror=\"#{onerror}\">"
  end

  def escape_html(value)
    value.to_s
      .gsub("&", "&amp;")
      .gsub("\"", "&quot;")
      .gsub("<", "&lt;")
      .gsub(">", "&gt;")
  end

  def json_for_script(value)
    JSON.generate(value)
      .gsub("</", "<\\/")
      .gsub("<!--", "<\\!--")
  end
end

Jekyll::Hooks.register [:posts, :pages, :documents], :pre_render do |doc|
  next unless doc.content&.include?("[[")

  index = WikiLinks.post_index(doc.site)

  doc.content = doc.content.gsub(WikiLinks::WIKI_IMAGE) do
    target = Regexp.last_match(1).strip

    WikiLinks.markdown_image(doc.site, target)
  end

  doc.content = doc.content.gsub(WikiLinks::WIKI_LINK) do
    text = Regexp.last_match(1).strip
    canvas = WikiLinks.canvas_embed(doc.site, text)
    next canvas if canvas

    post = index[WikiLinks.normalize(text)]

    post ? WikiLinks.markdown_link(doc.site, text, post) : Regexp.last_match(0)
  end
end
