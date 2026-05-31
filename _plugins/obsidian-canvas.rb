# frozen_string_literal: true

require "json"

module ObsidianCanvas
  module_function

  def canvas_files(site)
    Dir.glob(File.join(site.source, "**", "*.canvas")).select do |path|
      normalized = path.tr("\\", "/")
      !normalized.include?("/_site/") && !normalized.include?("/.git/")
    end
  end

  def slugify(title)
    slug = Jekyll::Utils.slugify(title, mode: "raw", cased: false)
    return slug unless slug.empty?

    title.to_s.downcase.gsub(/\s+/, "-")
  end
end

Jekyll::Hooks.register :site, :post_read do |site|
  ObsidianCanvas.canvas_files(site).each do |path|
    title = File.basename(path, ".canvas")
    slug = ObsidianCanvas.slugify(title)
    data = JSON.parse(File.read(path, encoding: "UTF-8"))

    page = Jekyll::PageWithoutAFile.new(site, site.source, "canvas/#{slug}", "index.html")
    page.content = ""
    page.data["layout"] = "obsidian-canvas"
    page.data["title"] = title
    page.data["canvas_source"] = path.sub(%r!\A#{Regexp.escape(site.source)}[/\\]?!i, "")
    page.data["canvas_data"] = data
    page.data["sitemap"] = false

    site.pages << page
  rescue JSON::ParserError => e
    Jekyll.logger.warn "ObsidianCanvas:", "Skipping #{path}: #{e.message}"
  end
end

